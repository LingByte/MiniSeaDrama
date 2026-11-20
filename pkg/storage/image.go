// Copyright (c) 2026 lingbyte. All rights reserved.

package storage

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"strings"

	_ "image/gif" // decode support
)

const (
	// CoverMaxEdge 封面最长边像素（竖版 3:4 约 810×1080）
	CoverMaxEdge = 1080
	// CoverJPEGQuality JPEG 压缩质量（1–100）
	CoverJPEGQuality = 78
)

func init() {
	// 确保 png 编码器可用（解码已由 image/png 隐式注册）
	_ = png.Encode
}

// CompressCover 将封面压成 JPEG：缩放到最长边 ≤ CoverMaxEdge，质量 CoverJPEGQuality。
// 已足够小且本身是 JPEG 时仍会统一重编码，保证体积可控。
func CompressCover(src []byte) ([]byte, error) {
	if len(src) == 0 {
		return nil, fmt.Errorf("empty image")
	}
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w < 1 || h < 1 {
		return nil, fmt.Errorf("invalid image size")
	}
	nw, nh := w, h
	if w >= h && w > CoverMaxEdge {
		nw = CoverMaxEdge
		nh = h * CoverMaxEdge / w
	} else if h > w && h > CoverMaxEdge {
		nh = CoverMaxEdge
		nw = w * CoverMaxEdge / h
	}
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	outImg := img
	if nw != w || nh != h {
		outImg = resizeNearest(img, nw, nh)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, outImg, &jpeg.Options{Quality: CoverJPEGQuality}); err != nil {
		return nil, fmt.Errorf("jpeg encode: %w", err)
	}
	return buf.Bytes(), nil
}

// CoverObjectKey 生成封面对象 key（统一 .jpg）。
func CoverObjectKey(parts ...string) string {
	key := ObjectKey(parts...)
	if strings.HasSuffix(strings.ToLower(key), ".jpg") || strings.HasSuffix(strings.ToLower(key), ".jpeg") {
		return key
	}
	// 去掉原扩展名再加 .jpg
	if i := strings.LastIndex(key, "."); i > 0 && i > strings.LastIndex(key, "/") {
		key = key[:i]
	}
	return key + ".jpg"
}

func resizeNearest(src image.Image, nw, nh int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	for y := 0; y < nh; y++ {
		sy := sb.Min.Y + y*sh/nh
		for x := 0; x < nw; x++ {
			sx := sb.Min.X + x*sw/nw
			dst.Set(x, y, src.At(sx, sy))
		}
	}
	return dst
}
