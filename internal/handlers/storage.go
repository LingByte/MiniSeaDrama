// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"fmt"
	"io"
	"mime"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/types"
	pkgstorage "github.com/LingByte/miniseadrama/pkg/storage"

	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"
	"github.com/gin-gonic/gin"
)

// File upload / download / delete
// Uses pkg/storage package-level singleton (no dependency injection needed).

// UploadFile handles file upload.
// Form field: file (multipart/form-data)
// Optional field: dir (subdirectory, e.g. "avatars")
//
// Upload flow:
//  1. Validate file size (must not exceed storage.MaxFileSize)
//  2. Generate unique key (dir + timestamp + original filename)
//  3. Call pkgstorage.Write to store
//  4. Return key + publicURL
func (h *Handlers) UploadFile(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "no file provided: "+err.Error()))
		return
	}

	// Validate file size
	if err = pkgstorage.CheckFileSize(file.Size); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}

	// Optional subdirectory
	dir := sanitizePath(strings.TrimSpace(c.PostForm("dir")))

	// Generate unique key: dir/20060102_150405_filename
	filename := sanitizePath(filepath.Base(file.Filename))
	key := fmt.Sprintf("%s/%s_%s", dir, time.Now().Format("20060102_150405"), filename)
	if dir == "" {
		key = fmt.Sprintf("%s_%s", time.Now().Format("20060102_150405"), filename)
	}

	// Open uploaded file
	src, err := file.Open()
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, "failed to open file: "+err.Error()))
		return
	}
	defer src.Close()

	// 封面 / 头像：压缩为 JPEG 再入库
	if strings.EqualFold(dir, "covers") || strings.HasPrefix(strings.ToLower(dir), "covers/") ||
		strings.EqualFold(dir, "avatars") || strings.HasPrefix(strings.ToLower(dir), "avatars/") {
		raw, readErr := io.ReadAll(src)
		if readErr != nil {
			respgin.WriteError(c, response.New(response.CodeInternal, "failed to read file: "+readErr.Error()))
			return
		}
		compressed, cerr := pkgstorage.CompressCover(raw)
		if cerr != nil {
			respgin.WriteError(c, response.New(response.CodeBadRequest, "图片压缩失败："+cerr.Error()))
			return
		}
		key = pkgstorage.CoverObjectKey(strings.TrimSuffix(key, filepath.Ext(key)) + ".jpg")
		if err = pkgstorage.PutBytes(key, compressed); err != nil {
			respgin.WriteError(c, response.New(response.CodeInternal, "storage write failed: "+err.Error()))
			return
		}
		accessURL, _ := pkgstorage.SignedURL(key, pkgstorage.DisplayURLTTL)
		if accessURL == "" {
			accessURL = pkgstorage.PublicURL(key)
		}
		respgin.Created(c, types.FileUploadResponse{
			Key:       key,
			Name:      filepath.Base(key),
			Size:      int64(len(compressed)),
			PublicURL: accessURL,
		})
		return
	}

	// Write to storage
	if err = pkgstorage.Write(key, src); err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, "storage write failed: "+err.Error()))
		return
	}

	accessURL, _ := pkgstorage.SignedURL(key, pkgstorage.DisplayURLTTL)
	if accessURL == "" {
		accessURL = pkgstorage.PublicURL(key)
	}
	respgin.Created(c, types.FileUploadResponse{
		Key:       key,
		Name:      filename,
		Size:      file.Size,
		PublicURL: accessURL,
	})
}

// DownloadFile handles file download.
// Path parameter: key (storage key)
func (h *Handlers) DownloadFile(c *gin.Context) {
	key := c.Param("key")
	if key == "" {
		respgin.WriteError(c, response.Err(response.CodeBadRequest))
		return
	}

	reader, size, err := pkgstorage.Read(key)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "file not found"))
		return
	}
	defer reader.Close()

	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(key)))
	c.DataFromReader(200, size, "application/octet-stream", reader, nil)
}

// ServeSignedMedia 校验 HMAC 签名后流式返回对象（封面展示 / 剧本下载）。
// Query: key, exp, sig
func (h *Handlers) ServeSignedMedia(c *gin.Context) {
	key := sanitizePath(c.Query("key"))
	exp, _ := strconv.ParseInt(c.Query("exp"), 10, 64)
	sig := strings.TrimSpace(c.Query("sig"))
	if !pkgstorage.VerifyMedia(key, exp, sig) {
		respgin.WriteError(c, response.New(response.CodeForbidden, "链接已过期或无效，请重新获取"))
		return
	}
	reader, size, err := pkgstorage.Read(key)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "文件不存在或已清理"))
		return
	}
	defer reader.Close()
	ct := mime.TypeByExtension(filepath.Ext(key))
	if ct == "" {
		ct = "application/octet-stream"
	}
	c.Header("Cache-Control", "private, max-age=300")
	c.Header("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, filepath.Base(key)))
	c.DataFromReader(200, size, ct, reader, nil)
}

// DeleteFile handles file deletion.
// Path parameter: key (storage key)
func (h *Handlers) DeleteFile(c *gin.Context) {
	key := c.Param("key")
	if key == "" {
		respgin.WriteError(c, response.Err(response.CodeBadRequest))
		return
	}

	exists, err := pkgstorage.Exists(key)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	if !exists {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}

	if err = pkgstorage.Delete(key); err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, "delete failed: "+err.Error()))
		return
	}

	respgin.NoContent(c)
}

// sanitizePath cleans a path to prevent directory traversal.
// Removes "..", leading "/", and collapses duplicate slashes.
func sanitizePath(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "/")
	p = strings.ReplaceAll(p, "..", "")
	for strings.Contains(p, "//") {
		p = strings.ReplaceAll(p, "//", "/")
	}
	return p
}
