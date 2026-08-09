package api

import (
	"context"
	"errors"
	"mime"
	"sort"
	"strings"

	"github.com/openboard/openboard/server/internal/store"
)

const maxFilmRestoreMedia = 40_000

type restoredFilmBlob struct {
	key     string
	digest  string
	version string
}

func (s *Server) copyRestoredFilmBlob(ctx context.Context, tenantID, userID, projectID, sourceKey, expectedMIME, mimePrefix, digest, version, destination string, expectedBytes int64) (restoredFilmBlob, bool, error) {
	if protectedFilmBlobKey(sourceKey) || !strings.HasPrefix(destination, "film:") {
		return restoredFilmBlob{}, false, errors.New("restore media source must be an ordinary tenant upload")
	}
	value, err := s.readTenantBlob(ctx, tenantID, sourceKey, maxFilmRenderBytes)
	if err != nil || verifyFilmBlob(value, mimePrefix, expectedMIME, digest, version, expectedBytes) != nil {
		return restoredFilmBlob{}, false, errors.New("restored media is not a verified tenant object")
	}
	created := false
	if err := s.storeTenantBlobConditional(ctx, tenantID, userID, destination, value.Metadata.ContentType, value.Data, blobVersionAbsent); err != nil {
		if !errors.Is(err, errBlobObjectConflict) {
			return restoredFilmBlob{}, false, errors.New("restored media could not be copied into protected storage")
		}
		existing, readErr := s.readTenantBlob(ctx, tenantID, destination, maxFilmRenderBytes)
		if readErr != nil || existing.Metadata.ContentType != value.Metadata.ContentType || sha256Hex(existing.Data) != digest {
			return restoredFilmBlob{}, false, errors.New("protected restore media conflicts with existing bytes")
		}
		value = existing
	} else {
		created = true
		stored, readErr := s.readTenantBlob(ctx, tenantID, destination, maxFilmRenderBytes)
		if readErr != nil || stored.Metadata.ContentType != value.Metadata.ContentType || sha256Hex(stored.Data) != digest {
			return restoredFilmBlob{}, created, errors.New("protected restore media failed integrity verification")
		}
		value = stored
	}
	return restoredFilmBlob{key: destination, digest: digest, version: blobIdentityVersion(value)}, created, nil
}

func restoredFilmMediaKey(projectID, digest, mime string) string {
	return "film:media:" + projectID + ":restore:" + stableFilmID("media", digest, mime)
}

func filmRestoreReferenceKey(kind, entityID, field string) string {
	return kind + "\x00" + entityID + "\x00" + field
}

func filmRestoreReferences(document filmDocument) map[string]map[string]struct{} {
	references := map[string]map[string]struct{}{}
	add := func(storageKey, kind, entityID, field string) {
		if storageKey == "" || strings.HasPrefix(storageKey, "shot:") {
			return
		}
		if references[storageKey] == nil {
			references[storageKey] = map[string]struct{}{}
		}
		references[storageKey][filmRestoreReferenceKey(kind, entityID, field)] = struct{}{}
	}
	for _, shot := range document.Shots {
		add(shot.ImageStorageKey, "shot", shot.ID, "imageStorageKey")
		add(shot.AudioStorageKey, "shot", shot.ID, "audioStorageKey")
		add(shot.VideoStorageKey, "shot", shot.ID, "videoStorageKey")
	}
	for _, asset := range document.Assets {
		add(asset.MediaStorageKey, "asset", asset.ID, "mediaStorageKey")
	}
	for _, track := range document.Timeline.Tracks {
		for _, clip := range track.Clips {
			add(clip.Source, "timeline", clip.ID, "source")
		}
	}
	for _, deliverable := range document.Deliverables {
		add(deliverable.StorageKey, "deliverable", deliverable.ID, "storageKey")
	}
	return references
}

func protectedFilmDocumentKeys(document filmDocument) map[string]struct{} {
	keys := map[string]struct{}{}
	for key := range filmRestoreReferences(document) {
		if protectedFilmBlobKey(key) {
			keys[key] = struct{}{}
		}
	}
	return keys
}

func validateFilmRestoreMediaMetadata(document filmDocument, mediaItems []filmRestoreMedia) error {
	if len(mediaItems) == 0 {
		return nil
	}
	if len(mediaItems) > maxFilmRestoreMedia {
		return errors.New("restore media metadata exceeds its item limit")
	}
	references := filmRestoreReferences(document)
	seen := map[string]struct{}{}
	for _, item := range mediaItems {
		if _, ok := blobFilename(item.StorageKey); !ok || protectedFilmBlobKey(item.StorageKey) {
			return errors.New("restore media metadata contains an invalid source storage key")
		}
		if _, duplicate := seen[item.StorageKey]; duplicate {
			return errors.New("restore media metadata storage keys must be unique")
		}
		seen[item.StorageKey] = struct{}{}
		mediaType, parameters, err := mime.ParseMediaType(item.MIMEType)
		if err != nil || mediaType != item.MIMEType || len(parameters) != 0 || item.Bytes < 1 || item.Bytes > maxFilmRenderBytes ||
			!validSHA256Hex(item.SHA256) || strings.TrimSpace(item.ObjectVersion) == "" || len(item.ObjectVersion) > 1_024 ||
			len(item.Provenance) == 0 || len(item.Provenance) > maxFilmEntities*4 {
			return errors.New("restore media metadata is invalid")
		}
		expected := references[item.StorageKey]
		if len(expected) == 0 || len(expected) != len(item.Provenance) {
			return errors.New("restore media provenance does not match the film document")
		}
		provenanceSeen := map[string]struct{}{}
		for _, provenance := range item.Provenance {
			key := filmRestoreReferenceKey(provenance.Kind, provenance.EntityID, provenance.Field)
			if _, ok := expected[key]; !ok {
				return errors.New("restore media provenance does not match the film document")
			}
			if _, duplicate := provenanceSeen[key]; duplicate {
				return errors.New("restore media provenance entries must be unique")
			}
			provenanceSeen[key] = struct{}{}
		}
		if err := validateFilmRestoreIdentity(document, item); err != nil {
			return err
		}
	}
	for storageKey := range references {
		if protectedFilmBlobKey(storageKey) {
			continue
		}
		if _, ok := seen[storageKey]; !ok {
			return errors.New("restore media metadata is missing a referenced tenant object")
		}
	}
	return nil
}

func validateFilmRestoreIdentity(document filmDocument, item filmRestoreMedia) error {
	match := func(mimePrefix, mimeType, digest, version string, bytes int64) error {
		if mimePrefix != "" && !strings.HasPrefix(item.MIMEType, mimePrefix) || mimeType != "" && item.MIMEType != mimeType ||
			digest != item.SHA256 || version != "" && version != item.ObjectVersion || bytes > 0 && bytes != item.Bytes {
			return errors.New("restore media metadata does not match document identity fields")
		}
		return nil
	}
	for _, provenance := range item.Provenance {
		matched := false
		var identityErr error
		switch provenance.Kind {
		case "shot":
			for _, shot := range document.Shots {
				if shot.ID != provenance.EntityID {
					continue
				}
				switch provenance.Field {
				case "imageStorageKey":
					identityErr = match("image/", "", shot.ImageSHA256, shot.ImageObjectVersion, 0)
					matched = true
				case "audioStorageKey":
					identityErr = match("audio/", "", shot.AudioSHA256, shot.AudioObjectVersion, 0)
					matched = true
				case "videoStorageKey":
					identityErr = match("video/", "", shot.VideoSHA256, shot.VideoObjectVersion, 0)
					matched = true
				}
				break
			}
		case "asset":
			for _, asset := range document.Assets {
				if asset.ID == provenance.EntityID && provenance.Field == "mediaStorageKey" {
					identityErr = match("", asset.MediaMIMEType, asset.MediaSHA256, asset.MediaObjectVersion, 0)
					matched = true
					break
				}
			}
		case "timeline":
			for _, track := range document.Timeline.Tracks {
				for _, clip := range track.Clips {
					if clip.ID != provenance.EntityID || provenance.Field != "source" {
						continue
					}
					switch track.Kind {
					case "video":
						identityErr = match("video/", "", item.SHA256, item.ObjectVersion, item.Bytes)
					case "dialogue", "music", "sfx":
						identityErr = match("audio/", "", item.SHA256, item.ObjectVersion, item.Bytes)
					case "subtitle":
						identityErr = match("", "application/x-subrip", item.SHA256, item.ObjectVersion, item.Bytes)
					default:
						identityErr = errors.New("restore timeline media kind is unsupported")
					}
					matched = true
					break
				}
				if matched {
					break
				}
			}
		case "deliverable":
			for _, deliverable := range document.Deliverables {
				if deliverable.ID == provenance.EntityID && provenance.Field == "storageKey" {
					identityErr = match("", deliverable.MIMEType, deliverable.SHA256, deliverable.ObjectVersion, deliverable.Bytes)
					matched = true
					break
				}
			}
		}
		if !matched {
			return errors.New("restore media provenance target is invalid")
		}
		if identityErr != nil {
			return identityErr
		}
	}
	return nil
}

func (s *Server) verifyProtectedRestoredFilmBlob(ctx context.Context, tenantID, projectID, sourceKey, expectedMIME, mimePrefix, digest, version string, expectedBytes int64, allowed map[string]struct{}) (restoredFilmBlob, error) {
	if _, ok := allowed[sourceKey]; !ok ||
		(!strings.HasPrefix(sourceKey, "film:media:"+projectID+":") && !strings.HasPrefix(sourceKey, "film:deliverable:"+projectID+":")) {
		return restoredFilmBlob{}, errors.New("restore media protected key is not referenced by the current film document")
	}
	value, err := s.readTenantBlob(ctx, tenantID, sourceKey, maxFilmRenderBytes)
	if err != nil || verifyFilmBlob(value, mimePrefix, expectedMIME, digest, version, expectedBytes) != nil {
		return restoredFilmBlob{}, errors.New("restored protected media no longer matches its verified identity")
	}
	return restoredFilmBlob{key: sourceKey, digest: digest, version: blobIdentityVersion(value)}, nil
}

func (s *Server) rehydrateRestoredFilmMedia(ctx context.Context, tenantID, userID string, input filmDocument, mediaItems []filmRestoreMedia, allowedProtected map[string]struct{}) (filmDocument, []string, []string, error) {
	document := cloneFilmDocument(input)
	createdKeys := []string{}
	migratedSources := map[string]struct{}{}
	cache := map[string]restoredFilmBlob{}
	verifiedSources := map[string]restoredFilmBlob{}
	mediaBySource := make(map[string]filmRestoreMedia, len(mediaItems))
	for _, item := range mediaItems {
		mediaBySource[item.StorageKey] = item
	}
	copyMedia := func(source, mime, prefix, digest, version string, bytes int64, deliverableID string) (restoredFilmBlob, error) {
		if item, ok := mediaBySource[source]; ok {
			mime, digest, version, bytes = item.MIMEType, item.SHA256, item.ObjectVersion, item.Bytes
		}
		cacheKey := prefix + "\x00" + source + "\x00" + digest + "\x00" + deliverableID
		if value, ok := cache[cacheKey]; ok {
			return value, nil
		}
		if protectedFilmBlobKey(source) {
			value, err := s.verifyProtectedRestoredFilmBlob(ctx, tenantID, document.ProjectID, source, mime, prefix, digest, version, bytes, allowedProtected)
			if err != nil {
				return restoredFilmBlob{}, err
			}
			cache[cacheKey] = value
			return value, nil
		}
		destination := restoredFilmMediaKey(document.ProjectID, digest, mime)
		if deliverableID != "" {
			destination = "film:deliverable:" + document.ProjectID + ":restore:" + stableFilmID("deliverable", deliverableID, digest)
		}
		value, created, err := s.copyRestoredFilmBlob(ctx, tenantID, userID, document.ProjectID, source, mime, prefix, digest, version, destination, bytes)
		if created {
			createdKeys = append(createdKeys, destination)
		}
		if err != nil {
			return restoredFilmBlob{}, err
		}
		migratedSources[source] = struct{}{}
		cache[cacheKey] = value
		return value, nil
	}
	fail := func(err error) (filmDocument, []string, []string, error) {
		s.cleanupRestoredFilmBlobs(ctx, tenantID, userID, document.ProjectID, createdKeys)
		return filmDocument{}, nil, nil, err
	}
	for index := range document.Shots {
		shot := &document.Shots[index]
		for _, stage := range []string{"storyboard", "audio", "video"} {
			key, digest, version, _, prefix := filmShotMediaIdentity(*shot, stage)
			if key == "" {
				continue
			}
			value, err := copyMedia(key, "", prefix, digest, version, 0, "")
			if err != nil {
				return fail(err)
			}
			switch stage {
			case "storyboard":
				shot.ImageStorageKey, shot.ImageSHA256, shot.ImageObjectVersion, shot.ImageGenerationJobID = value.key, value.digest, value.version, ""
			case "audio":
				shot.AudioStorageKey, shot.AudioSHA256, shot.AudioObjectVersion, shot.AudioGenerationJobID = value.key, value.digest, value.version, ""
			case "video":
				shot.VideoStorageKey, shot.VideoSHA256, shot.VideoObjectVersion, shot.VideoGenerationJobID = value.key, value.digest, value.version, ""
			}
			shot.MediaProvenance = "restore"
			verifiedSources[prefix+"\x00"+key] = value
		}
	}
	for index := range document.Assets {
		asset := &document.Assets[index]
		if asset.MediaStorageKey == "" {
			continue
		}
		value, err := copyMedia(asset.MediaStorageKey, asset.MediaMIMEType, "", asset.MediaSHA256, asset.MediaObjectVersion, 0, "")
		if err != nil {
			return fail(err)
		}
		asset.MediaStorageKey, asset.MediaSHA256, asset.MediaObjectVersion, asset.MediaProvenance = value.key, value.digest, value.version, "restore"
		prefix := strings.SplitN(asset.MediaMIMEType, "/", 2)[0] + "/"
		verifiedSources[prefix+"\x00"+input.Assets[index].MediaStorageKey] = value
	}
	for trackIndex := range document.Timeline.Tracks {
		track := &document.Timeline.Tracks[trackIndex]
		for clipIndex := range track.Clips {
			clip := &track.Clips[clipIndex]
			if strings.HasPrefix(clip.Source, "shot:") {
				continue
			}
			prefix := "audio/"
			if track.Kind == "video" {
				prefix = "video/"
			} else if track.Kind == "subtitle" {
				prefix = ""
			}
			copied, ok := verifiedSources[prefix+"\x00"+clip.Source]
			if !ok {
				item, hasMetadata := mediaBySource[clip.Source]
				if !hasMetadata {
					return fail(errors.New("restored timeline media is not a verified tenant object"))
				}
				var err error
				copied, err = copyMedia(clip.Source, item.MIMEType, prefix, item.SHA256, item.ObjectVersion, item.Bytes, "")
				if err != nil {
					return fail(err)
				}
			}
			clip.Source = copied.key
		}
	}
	for index := range document.Deliverables {
		deliverable := &document.Deliverables[index]
		if deliverable.StorageKey == "" {
			continue
		}
		value, err := copyMedia(deliverable.StorageKey, deliverable.MIMEType, "", deliverable.SHA256, deliverable.ObjectVersion, deliverable.Bytes, deliverable.ID)
		if err != nil {
			return fail(err)
		}
		deliverable.StorageKey, deliverable.SHA256, deliverable.ObjectVersion, deliverable.Provenance = value.key, value.digest, value.version, "restore"
	}
	if err := validateFilmAggregate(document, document.ProjectID); err != nil {
		return fail(err)
	}
	migratedStorageKeys := make([]string, 0, len(migratedSources))
	for key := range migratedSources {
		migratedStorageKeys = append(migratedStorageKeys, key)
	}
	sort.Strings(migratedStorageKeys)
	return document, createdKeys, migratedStorageKeys, nil
}

func (s *Server) cleanupRestoredFilmBlobs(parent context.Context, tenantID, userID, projectID string, keys []string) {
	if len(keys) == 0 {
		return
	}
	ctx, cancel := detachedFilmContext(parent)
	defer cancel()
	document, err := s.latestFilmDocument(ctx, tenantID, projectID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return
	}
	referenced := filmRestoreReferences(document)
	for _, key := range keys {
		if _, ok := referenced[key]; ok {
			continue
		}
		if err := s.deleteTenantBlob(ctx, tenantID, userID, key); err != nil && !errors.Is(err, store.ErrNotFound) {
			continue
		}
	}
}
