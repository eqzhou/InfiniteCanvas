package api

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	defaultFilmImportBytes     = int64(50 << 20)
	maxFilmImportBytes         = int64(100 << 20)
	maxFilmJSONImportBytes     = int64(4 << 20)
	maxFilmDOCXEntries         = 2_048
	maxFilmDOCXExpanded        = int64(64 << 20)
	maxFilmPDFStreams          = 256
	maxFilmPDFExpandedBytes    = int64(32 << 20)
	maxFilmPDFStreamBytes      = int64(8 << 20)
	maxFilmPDFOperators        = 20_000
	maxFilmPDFCompressionRatio = 200
)

var (
	errFilmPDFNeedsOCR = errors.New("PDF has no usable text layer; run OCR first and import the OCR result")
	errFilmImportBusy  = errors.New("film import concurrency or rate limit reached")
)

type filmImportJSONRequest struct {
	Revision      int    `json:"revision"`
	Text          string `json:"text,omitempty"`
	Format        string `json:"format,omitempty"`
	OriginalName  string `json:"originalName,omitempty"`
	MIMEType      string `json:"mimeType,omitempty"`
	ContentBase64 string `json:"contentBase64,omitempty"`
}

type filmImportPayload struct {
	revision int
	name     string
	mimeType string
	format   string
	data     []byte
}

func filmImportByteLimit() int64 {
	raw := strings.TrimSpace(os.Getenv("OPENBOARD_FILM_IMPORT_MAX_BYTES"))
	if raw == "" {
		return defaultFilmImportBytes
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1<<20 || value > maxFilmImportBytes {
		return defaultFilmImportBytes
	}
	return value
}

func cleanFilmImportName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 255 || strings.ContainsAny(value, "\x00\r\n/\\") || filepath.Base(value) != value {
		return "", errors.New("import filename is invalid")
	}
	return value, nil
}

func normalizedFilmImportMIME(value string) (string, error) {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil || mediaType == "" {
		return "", errors.New("import MIME type is invalid")
	}
	return strings.ToLower(mediaType), nil
}

func extractFilmImport(filename, mimeType string, data []byte, limit int64) (string, string, error) {
	name, err := cleanFilmImportName(filename)
	if err != nil {
		return "", "", err
	}
	if limit < 1 || int64(len(data)) > limit {
		return "", "", errors.New("manuscript import exceeds its configured size limit")
	}
	mediaType, err := normalizedFilmImportMIME(mimeType)
	if err != nil {
		return "", "", err
	}
	extension := strings.ToLower(filepath.Ext(name))
	switch extension {
	case ".txt":
		if mediaType != "text/plain" && mediaType != "application/octet-stream" {
			return "", "", errors.New("TXT extension and MIME type do not match")
		}
		text, err := extractFilmPlainText(data)
		return text, "txt", err
	case ".md", ".markdown":
		if mediaType != "text/markdown" && mediaType != "text/x-markdown" && mediaType != "text/plain" && mediaType != "application/octet-stream" {
			return "", "", errors.New("Markdown extension and MIME type do not match")
		}
		text, err := extractFilmPlainText(data)
		return text, "markdown", err
	case ".docx":
		if mediaType != "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
			return "", "", errors.New("DOCX extension and MIME type do not match")
		}
		text, err := extractFilmDOCX(data, limit)
		return text, "docx", err
	case ".pdf":
		if mediaType != "application/pdf" {
			return "", "", errors.New("PDF extension and MIME type do not match")
		}
		text, err := extractFilmPDF(data, limit)
		return text, "pdf", err
	default:
		return "", "", errors.New("manuscript extension must be .txt, .md, .markdown, .docx, or .pdf")
	}
}

func extractFilmPlainText(data []byte) (string, error) {
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	if len(data) == 0 || len(data) > maxFilmSourceBytes || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return "", errors.New("manuscript text is empty, binary, invalid UTF-8, or exceeds the extracted-text limit")
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return "", errors.New("manuscript text is empty")
	}
	return text, nil
}

func safeFilmZipName(name string) bool {
	return name != "" && len(name) <= 512 && !strings.ContainsAny(name, "\x00\\") && !strings.HasPrefix(name, "/") && path.Clean(name) == name && name != "." && name != ".." && !strings.HasPrefix(name, "../")
}

func extractFilmDOCX(data []byte, limit int64) (string, error) {
	if len(data) < 4 || !(bytes.Equal(data[:4], []byte{'P', 'K', 3, 4}) || bytes.Equal(data[:4], []byte{'P', 'K', 5, 6}) || bytes.Equal(data[:4], []byte{'P', 'K', 7, 8})) {
		return "", errors.New("DOCX ZIP signature is invalid")
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(reader.File) == 0 || len(reader.File) > maxFilmDOCXEntries {
		return "", errors.New("DOCX archive is invalid or contains too many entries")
	}
	expandedLimit := maxFilmDOCXExpanded
	if limit < expandedLimit {
		expandedLimit = limit
	}
	var total uint64
	entries := make(map[string]struct{}, len(reader.File))
	var document, contentTypes *zip.File
	for _, entry := range reader.File {
		if !safeFilmZipName(entry.Name) || entry.FileInfo().IsDir() && !strings.HasSuffix(entry.Name, "/") {
			return "", errors.New("DOCX archive contains an unsafe entry path")
		}
		if _, duplicate := entries[entry.Name]; duplicate {
			return "", errors.New("DOCX archive contains duplicate entries")
		}
		entries[entry.Name] = struct{}{}
		total += entry.UncompressedSize64
		if entry.UncompressedSize64 > uint64(expandedLimit) || total > uint64(expandedLimit) {
			return "", errors.New("DOCX archive expands beyond its safety limit")
		}
		if entry.UncompressedSize64 > 1<<20 && entry.CompressedSize64 > 0 && entry.UncompressedSize64/entry.CompressedSize64 > 200 {
			return "", errors.New("DOCX archive compression ratio is unsafe")
		}
		if entry.Name == "word/document.xml" {
			document = entry
		} else if entry.Name == "[Content_Types].xml" {
			contentTypes = entry
		}
	}
	if document == nil || contentTypes == nil {
		return "", errors.New("DOCX is missing required OOXML parts")
	}
	if err := validateFilmDOCXContentTypes(contentTypes); err != nil {
		return "", err
	}
	stream, err := document.Open()
	if err != nil {
		return "", errors.New("DOCX document XML cannot be opened")
	}
	defer stream.Close()
	decoder := xml.NewDecoder(io.LimitReader(stream, expandedLimit+1))
	decoder.Strict = true
	var output strings.Builder
	inText := false
	for {
		token, tokenErr := decoder.Token()
		if errors.Is(tokenErr, io.EOF) {
			break
		}
		if tokenErr != nil {
			return "", errors.New("DOCX document XML is invalid")
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "t":
				inText = true
			case "tab":
				output.WriteByte('\t')
			case "br", "cr":
				output.WriteByte('\n')
			}
		case xml.EndElement:
			if value.Name.Local == "t" {
				inText = false
			}
			if value.Name.Local == "p" && output.Len() > 0 {
				output.WriteByte('\n')
			}
		case xml.CharData:
			if inText {
				output.Write(value)
			}
		}
		if output.Len() > maxFilmSourceBytes {
			return "", errors.New("DOCX extracted text exceeds its limit")
		}
	}
	return extractFilmPlainText([]byte(output.String()))
}

func validateFilmDOCXContentTypes(entry *zip.File) error {
	if entry.UncompressedSize64 > 1<<20 {
		return errors.New("DOCX content types metadata exceeds its limit")
	}
	stream, err := entry.Open()
	if err != nil {
		return errors.New("DOCX content types metadata cannot be opened")
	}
	defer stream.Close()
	decoder := xml.NewDecoder(io.LimitReader(stream, (1<<20)+1))
	decoder.Strict = true
	found := false
	for {
		token, tokenErr := decoder.Token()
		if errors.Is(tokenErr, io.EOF) {
			break
		}
		if tokenErr != nil {
			return errors.New("DOCX content types metadata is invalid")
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "Override" {
			continue
		}
		partName, contentType := "", ""
		for _, attribute := range start.Attr {
			switch attribute.Name.Local {
			case "PartName":
				partName = attribute.Value
			case "ContentType":
				contentType = attribute.Value
			}
		}
		if partName == "/word/document.xml" && contentType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" {
			found = true
		}
	}
	if !found {
		return errors.New("DOCX content types do not declare the main document")
	}
	return nil
}

func extractFilmPDF(data []byte, limit int64) (string, error) {
	if int64(len(data)) > limit {
		return "", errors.New("PDF exceeds its configured size limit")
	}
	if err := validateFilmPDFStructure(data); err != nil {
		return "", err
	}
	var output strings.Builder
	totalExpanded, operatorCount, streamCount := int64(0), 0, 0
	for offset := 0; offset < len(data); {
		index := bytes.Index(data[offset:], []byte("stream"))
		if index < 0 {
			break
		}
		streamOffset := offset + index
		if streamOffset > 0 && !unicode.IsSpace(rune(data[streamOffset-1])) && data[streamOffset-1] != '>' {
			offset = streamOffset + len("stream")
			continue
		}
		streamCount++
		if streamCount > maxFilmPDFStreams {
			return "", errors.New("PDF contains too many streams")
		}
		start := streamOffset + len("stream")
		if start < len(data) && data[start] == '\r' {
			start++
		}
		if start < len(data) && data[start] == '\n' {
			start++
		}
		endRelative := bytes.Index(data[start:], []byte("endstream"))
		if endRelative < 0 {
			return "", errors.New("PDF stream is malformed")
		}
		end := start + endRelative
		dictionaryStart := bytes.LastIndex(data[maxInt(0, streamOffset-4096):streamOffset], []byte("<<"))
		if dictionaryStart < 0 {
			return "", errors.New("PDF stream dictionary is malformed")
		}
		dictionaryStart += maxInt(0, streamOffset-4096)
		dictionaryEnd := bytes.LastIndex(data[dictionaryStart:streamOffset], []byte(">>"))
		if dictionaryEnd < 0 {
			return "", errors.New("PDF stream dictionary is malformed")
		}
		dictionary := data[dictionaryStart : dictionaryStart+dictionaryEnd+2]
		content := bytes.TrimRight(data[start:end], "\r\n")
		var expanded []byte
		if bytes.Contains(dictionary, []byte("/FlateDecode")) {
			zreader, err := zlib.NewReader(bytes.NewReader(content))
			if err != nil {
				return "", errors.New("PDF compressed text stream is invalid")
			}
			expanded, err = io.ReadAll(io.LimitReader(zreader, maxFilmPDFStreamBytes+1))
			closeErr := zreader.Close()
			if err != nil || closeErr != nil || int64(len(expanded)) > maxFilmPDFStreamBytes {
				return "", errors.New("PDF text stream exceeds its expansion limit")
			}
			if len(content) == 0 || int64(len(expanded))/int64(len(content)) > maxFilmPDFCompressionRatio {
				return "", errors.New("PDF stream compression ratio is unsafe")
			}
		} else {
			if int64(len(content)) > maxFilmPDFStreamBytes {
				return "", errors.New("PDF text stream exceeds its expansion limit")
			}
			expanded = content
		}
		totalExpanded += int64(len(expanded))
		if totalExpanded > maxFilmPDFExpandedBytes {
			return "", errors.New("PDF streams exceed the global expansion limit")
		}
		if err := extractPDFTextOperators(expanded, &output, &operatorCount); err != nil {
			return "", err
		}
		if output.Len() > maxFilmSourceBytes {
			return "", errors.New("PDF extracted text exceeds its limit")
		}
		offset = end + len("endstream")
	}
	text := strings.TrimSpace(strings.Join(strings.Fields(output.String()), " "))
	if !usableFilmPDFText(text) {
		return "", errFilmPDFNeedsOCR
	}
	return text, nil
}

func extractPDFTextOperators(data []byte, output *strings.Builder, operatorCount *int) error {
	for offset := 0; offset < len(data); {
		begin := bytes.Index(data[offset:], []byte("BT"))
		if begin < 0 {
			return nil
		}
		*operatorCount++
		if *operatorCount > maxFilmPDFOperators {
			return errors.New("PDF text operator limit exceeded")
		}
		begin += offset + 2
		endRelative := bytes.Index(data[begin:], []byte("ET"))
		if endRelative < 0 {
			return errors.New("PDF text object is malformed")
		}
		block := data[begin : begin+endRelative]
		for index := 0; index < len(block); index++ {
			switch block[index] {
			case '(':
				*operatorCount++
				if *operatorCount > maxFilmPDFOperators {
					return errors.New("PDF text operator limit exceeded")
				}
				value, next, ok := readPDFLiteral(block, index)
				if ok {
					output.WriteString(value)
					output.WriteByte('\n')
					index = next - 1
				}
			case '<':
				if index+1 < len(block) && block[index+1] == '<' {
					continue
				}
				end := bytes.IndexByte(block[index+1:], '>')
				if end >= 0 {
					*operatorCount++
					if *operatorCount > maxFilmPDFOperators {
						return errors.New("PDF text operator limit exceeded")
					}
					raw := bytes.Map(func(r rune) rune {
						if unicode.IsSpace(r) {
							return -1
						}
						return r
					}, block[index+1:index+1+end])
					if len(raw)%2 == 1 {
						raw = append(raw, '0')
					}
					decoded := make([]byte, hex.DecodedLen(len(raw)))
					if _, err := hex.Decode(decoded, raw); err == nil && utf8.Valid(decoded) {
						output.Write(decoded)
						output.WriteByte('\n')
					}
					index += end + 1
				}
			}
		}
		offset = begin + endRelative + 2
	}
	return nil
}

func readPDFLiteral(data []byte, start int) (string, int, bool) {
	var output []byte
	depth := 1
	for index := start + 1; index < len(data); index++ {
		character := data[index]
		if character == '\\' {
			if index+1 >= len(data) {
				return "", index, false
			}
			index++
			next := data[index]
			switch next {
			case 'n':
				output = append(output, '\n')
			case 'r':
				output = append(output, '\r')
			case 't':
				output = append(output, '\t')
			case 'b':
				output = append(output, '\b')
			case 'f':
				output = append(output, '\f')
			case '\n':
			case '\r':
				if index+1 < len(data) && data[index+1] == '\n' {
					index++
				}
			default:
				if next >= '0' && next <= '7' {
					value := int(next - '0')
					for count := 0; count < 2 && index+1 < len(data) && data[index+1] >= '0' && data[index+1] <= '7'; count++ {
						index++
						value = value*8 + int(data[index]-'0')
					}
					output = append(output, byte(value))
				} else {
					output = append(output, next)
				}
			}
			continue
		}
		if character == '(' {
			depth++
		}
		if character == ')' {
			depth--
			if depth == 0 {
				if !utf8.Valid(output) {
					return "", index + 1, false
				}
				return string(output), index + 1, true
			}
		}
		output = append(output, character)
		if len(output) > maxFilmSourceBytes {
			return "", index, false
		}
	}
	return "", len(data), false
}

func usableFilmPDFText(value string) bool {
	if len([]rune(strings.TrimSpace(value))) < 4 {
		return false
	}
	printable, total := 0, 0
	for _, character := range value {
		total++
		if unicode.IsPrint(character) || unicode.IsSpace(character) {
			printable++
		}
	}
	return total > 0 && printable*10 >= total*8
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func decodeFilmImportPayload(w http.ResponseWriter, r *http.Request, limit int64) (filmImportPayload, error) {
	contentType := strings.TrimSpace(r.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/json"
	}
	mediaType, parameters, err := mime.ParseMediaType(contentType)
	if err != nil {
		return filmImportPayload{}, errors.New("import Content-Type is invalid")
	}
	if strings.HasPrefix(strings.ToLower(mediaType), "multipart/") {
		boundary := parameters["boundary"]
		if boundary == "" || len(boundary) > 200 {
			return filmImportPayload{}, errors.New("multipart boundary is invalid")
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit+(1<<20))
		reader := multipart.NewReader(r.Body, boundary)
		payload := filmImportPayload{revision: -1}
		reachedEOF := false
		for count := 0; count < 8; count++ {
			part, partErr := reader.NextPart()
			if errors.Is(partErr, io.EOF) {
				reachedEOF = true
				break
			}
			if partErr != nil {
				return filmImportPayload{}, errors.New("multipart import is invalid or exceeds its limit")
			}
			name := part.FormName()
			switch name {
			case "revision":
				value, readErr := io.ReadAll(io.LimitReader(part, 32))
				if readErr != nil || payload.revision >= 0 {
					return filmImportPayload{}, errors.New("multipart revision is invalid")
				}
				payload.revision, readErr = strconv.Atoi(strings.TrimSpace(string(value)))
				if readErr != nil {
					return filmImportPayload{}, errors.New("multipart revision is invalid")
				}
			case "file":
				if payload.data != nil {
					return filmImportPayload{}, errors.New("multipart import must contain one file")
				}
				payload.name = part.FileName()
				payload.mimeType = part.Header.Get("Content-Type")
				payload.data, partErr = io.ReadAll(io.LimitReader(part, limit+1))
				if partErr != nil || int64(len(payload.data)) > limit {
					return filmImportPayload{}, errors.New("multipart file exceeds its configured size limit")
				}
			case "format":
				value, readErr := io.ReadAll(io.LimitReader(part, 32))
				if readErr != nil || payload.format != "" {
					return filmImportPayload{}, errors.New("multipart format is invalid")
				}
				payload.format = strings.ToLower(strings.TrimSpace(string(value)))
				if payload.format == "md" {
					payload.format = "markdown"
				}
				if payload.format != "txt" && payload.format != "text" && payload.format != "markdown" && payload.format != "docx" && payload.format != "pdf" {
					return filmImportPayload{}, errors.New("multipart format is invalid")
				}
			default:
				return filmImportPayload{}, errors.New("multipart import contains an unknown field")
			}
			_ = part.Close()
		}
		if !reachedEOF {
			if err := requireMultipartEOF(reader); err != nil {
				return filmImportPayload{}, errors.New("multipart import contains too many parts")
			}
		}
		if payload.revision < 0 || payload.data == nil {
			return filmImportPayload{}, errors.New("multipart import requires revision and file")
		}
		return payload, nil
	}
	if strings.ToLower(mediaType) != "application/json" {
		return filmImportPayload{}, errors.New("import must use application/json or multipart/form-data")
	}
	jsonLimit := limit
	if jsonLimit > maxFilmJSONImportBytes {
		jsonLimit = maxFilmJSONImportBytes
	}
	bodyLimit := jsonLimit*4/3 + (256 << 10)
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input filmImportJSONRequest
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || input.Revision < 0 || (input.Text == "") == (input.ContentBase64 == "") {
		return filmImportPayload{}, errors.New("JSON import is invalid or exceeds its limit")
	}
	payload := filmImportPayload{revision: input.Revision, name: input.OriginalName, mimeType: input.MIMEType, format: strings.ToLower(strings.TrimSpace(input.Format))}
	if input.ContentBase64 != "" {
		decodedLen := base64.StdEncoding.DecodedLen(len(input.ContentBase64))
		if int64(decodedLen) > jsonLimit {
			return filmImportPayload{}, errors.New("JSON import exceeds its configured size limit")
		}
		payload.data = make([]byte, decodedLen)
		count, decodeErr := base64.StdEncoding.Decode(payload.data, []byte(input.ContentBase64))
		if decodeErr != nil {
			return filmImportPayload{}, errors.New("contentBase64 is invalid")
		}
		payload.data = payload.data[:count]
	} else {
		if int64(len(input.Text)) > jsonLimit {
			return filmImportPayload{}, errors.New("JSON import exceeds its configured size limit")
		}
		payload.data = []byte(input.Text)
		format := strings.ToLower(strings.TrimSpace(input.Format))
		if format == "md" {
			format = "markdown"
		}
		if payload.name == "" {
			if format == "markdown" {
				payload.name = "manuscript.md"
			} else {
				payload.name = "manuscript.txt"
			}
		}
		if payload.mimeType == "" {
			if format == "markdown" {
				payload.mimeType = "text/markdown"
			} else {
				payload.mimeType = "text/plain"
			}
		}
	}
	return payload, nil
}

func requireMultipartEOF(reader *multipart.Reader) error {
	part, err := reader.NextPart()
	if errors.Is(err, io.EOF) {
		return nil
	}
	if part != nil {
		_ = part.Close()
	}
	if err != nil {
		return err
	}
	return errors.New("multipart data exceeds its part limit")
}

func (s *Server) importFilmSource(w http.ResponseWriter, r *http.Request) {
	release, gateErr := s.acquireFilmImport(r.Context(), tenantIDFrom(r))
	if gateErr != nil {
		writeFilmError(w, http.StatusTooManyRequests, "film_import_busy", "Film import concurrency or rate limit reached; retry later")
		return
	}
	defer release()
	limit := filmImportByteLimit()
	payload, err := decodeFilmImportPayload(w, r, limit)
	if err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_import", err.Error())
		return
	}
	text, format, err := extractFilmImport(payload.name, payload.mimeType, payload.data, limit)
	if err != nil {
		code := "import_rejected"
		if errors.Is(err, errFilmPDFNeedsOCR) {
			code = "pdf_ocr_required"
		}
		writeFilmError(w, http.StatusUnprocessableEntity, code, err.Error())
		return
	}
	if payload.format != "" && payload.format != format && !(payload.format == "text" && format == "txt") {
		writeFilmError(w, http.StatusBadRequest, "invalid_import", "declared import format does not match the validated file")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if document.Source.Revision != payload.revision {
			return filmDocument{}, errors.New("source revision conflict")
		}
		document.Source.Format = format
		document.Source.OriginalName = payload.name
		return decomposeFilmSource(document, text)
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}
