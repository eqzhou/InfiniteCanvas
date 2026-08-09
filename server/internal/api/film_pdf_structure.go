package api

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
)

const maxFilmPDFObjects = 4096

type filmPDFXref struct {
	offset     int
	generation string
}

func validateFilmPDFStructure(data []byte) error {
	if len(data) < 64 || !bytes.HasPrefix(data, []byte("%PDF-")) || !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
		return errors.New("PDF signature or trailer is invalid")
	}
	eof := bytes.LastIndex(data, []byte("%%EOF"))
	startMarker := bytes.LastIndex(data[:eof], []byte("startxref"))
	if startMarker < 0 {
		return errors.New("PDF startxref is missing")
	}
	startFields := bytes.Fields(data[startMarker+len("startxref") : eof])
	if len(startFields) != 1 {
		return errors.New("PDF startxref is malformed")
	}
	xrefOffset, err := strconv.Atoi(string(startFields[0]))
	if err != nil || xrefOffset < 0 || xrefOffset >= startMarker || !bytes.HasPrefix(data[xrefOffset:], []byte("xref")) {
		return errors.New("PDF xref offset is invalid")
	}
	xref, trailer, err := parseFilmPDFXref(data[xrefOffset:startMarker])
	if err != nil {
		return err
	}
	for _, entry := range xref {
		if entry.offset <= 0 || entry.offset >= xrefOffset {
			return errors.New("PDF xref object offset is invalid")
		}
	}
	rootID, rootGeneration, ok := filmPDFReference(trailer, "/Root")
	if !ok {
		return errors.New("PDF trailer root is invalid")
	}
	root, ok := filmPDFObject(data, xref, rootID, rootGeneration)
	if !ok || !bytes.Contains(root, []byte("/Type /Catalog")) {
		return errors.New("PDF catalog is invalid")
	}
	pagesID, pagesGeneration, ok := filmPDFReference(root, "/Pages")
	if !ok {
		return errors.New("PDF catalog pages reference is invalid")
	}
	pages, ok := filmPDFObject(data, xref, pagesID, pagesGeneration)
	if !ok || !bytes.Contains(pages, []byte("/Type /Pages")) {
		return errors.New("PDF page tree is invalid")
	}
	pageFound := false
	for id := range xref {
		object, exists := filmPDFObject(data, xref, id, "0")
		parentID, parentGeneration, hasParent := filmPDFReference(object, "/Parent")
		if exists && bytes.Contains(object, []byte("/Type /Page ")) && hasParent && parentID == pagesID && parentGeneration == pagesGeneration {
			pageFound = true
			break
		}
	}
	if !pageFound {
		return errors.New("PDF page tree has no valid page object")
	}
	return validateFilmPDFStreamLengths(data)
}

func parseFilmPDFXref(section []byte) (map[int]filmPDFXref, []byte, error) {
	trailerAt := bytes.Index(section, []byte("trailer"))
	if trailerAt < 0 {
		return nil, nil, errors.New("PDF trailer is missing")
	}
	fields := bytes.Fields(section[:trailerAt])
	if len(fields) < 3 || string(fields[0]) != "xref" {
		return nil, nil, errors.New("PDF xref is malformed")
	}
	first, firstErr := strconv.Atoi(string(fields[1]))
	count, countErr := strconv.Atoi(string(fields[2]))
	if firstErr != nil || countErr != nil || first != 0 || count < 2 || count > maxFilmPDFObjects+1 || len(fields) != 3+count*3 {
		return nil, nil, errors.New("PDF xref bounds are invalid")
	}
	result := make(map[int]filmPDFXref, count-1)
	for index := 0; index < count; index++ {
		base := 3 + index*3
		offset, offsetErr := strconv.Atoi(string(fields[base]))
		generation := string(fields[base+1])
		state := string(fields[base+2])
		if offsetErr != nil || len(generation) != 5 || (state != "n" && state != "f") {
			return nil, nil, errors.New("PDF xref entry is invalid")
		}
		if state == "n" {
			result[first+index] = filmPDFXref{offset: offset, generation: generation}
		}
	}
	if len(result) == 0 || len(result) > maxFilmPDFObjects {
		return nil, nil, errors.New("PDF object count is invalid")
	}
	return result, section[trailerAt+len("trailer"):], nil
}

func filmPDFReference(dictionary []byte, key string) (int, string, bool) {
	fields := bytes.Fields(dictionary)
	for index := 0; index+3 < len(fields); index++ {
		if string(fields[index]) != key || string(fields[index+3]) != "R" {
			continue
		}
		id, err := strconv.Atoi(string(fields[index+1]))
		generation := string(fields[index+2])
		return id, generation, err == nil && id > 0 && len(generation) <= 6
	}
	return 0, "", false
}

func filmPDFObject(data []byte, xref map[int]filmPDFXref, id int, generation string) ([]byte, bool) {
	entry, ok := xref[id]
	generationNumber, generationErr := strconv.Atoi(generation)
	if !ok || generationErr != nil || entry.generation != fmt.Sprintf("%05d", generationNumber) || entry.offset < 0 || entry.offset >= len(data) {
		return nil, false
	}
	header := []byte(fmt.Sprintf("%d %s obj", id, generation))
	if !bytes.HasPrefix(data[entry.offset:], header) {
		return nil, false
	}
	end := bytes.Index(data[entry.offset+len(header):], []byte("endobj"))
	if end < 0 || end > int(maxFilmPDFStreamBytes) {
		return nil, false
	}
	return data[entry.offset+len(header) : entry.offset+len(header)+end], true
}

func validateFilmPDFStreamLengths(data []byte) error {
	for offset := 0; offset < len(data); {
		relative := bytes.Index(data[offset:], []byte("stream"))
		if relative < 0 {
			return nil
		}
		marker := offset + relative
		if marker > 0 && data[marker-1] != '>' && data[marker-1] != '\n' && data[marker-1] != '\r' && data[marker-1] != ' ' {
			offset = marker + len("stream")
			continue
		}
		dictionaryStart := bytes.LastIndex(data[maxInt(0, marker-4096):marker], []byte("<<"))
		if dictionaryStart < 0 {
			return errors.New("PDF stream dictionary is malformed")
		}
		dictionaryStart += maxInt(0, marker-4096)
		dictionary := data[dictionaryStart:marker]
		lengthFields := bytes.Fields(dictionary)
		length := -1
		lengthCount := 0
		for index := 0; index+1 < len(lengthFields); index++ {
			if string(lengthFields[index]) == "/Length" {
				lengthCount++
				length, _ = strconv.Atoi(string(lengthFields[index+1]))
			}
		}
		if lengthCount != 1 || length < 0 || length > int(maxFilmPDFStreamBytes) {
			return errors.New("PDF stream Length is invalid")
		}
		start := marker + len("stream")
		if start < len(data) && data[start] == '\r' {
			start++
		}
		if start < len(data) && data[start] == '\n' {
			start++
		}
		end := start + length
		if end > len(data) {
			return errors.New("PDF stream Length exceeds its object")
		}
		after := end
		if after < len(data) && data[after] == '\r' {
			after++
		}
		if after < len(data) && data[after] == '\n' {
			after++
		}
		if !bytes.HasPrefix(data[after:], []byte("endstream")) {
			return errors.New("PDF stream Length does not match its contents")
		}
		offset = after + len("endstream")
	}
	return nil
}
