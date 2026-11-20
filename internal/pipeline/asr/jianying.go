// Copyright (c) 2026 lingbyte. All rights reserved.

package asr

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// JianYingASR uses CapCut/Jianying cloud ASR with external sign helper.
type JianYingASR struct {
	fileBinary []byte
	crcHex     string
	client     *http.Client
	tdid       string

	accessKey    string
	secretKey    string
	sessionToken string
	storeURI     string
	auth         string
	uploadID     string
	uploadHost   string
}

func newJianYing(path string) (*JianYingASR, error) {
	data, err := readAudio(path)
	if err != nil {
		return nil, err
	}
	tdid := "3943278516897751"
	if time.Now().Year() != 2024 {
		// stable pseudo device id from hostname hash
		h := crc32Hex([]byte(hostname()))
		if n, err := strconv.ParseUint(h[:8], 16, 64); err == nil {
			tdid = fmt.Sprintf("%012d", n%1_000_000_000_000)
		}
	}
	return &JianYingASR{
		fileBinary: data,
		crcHex:     crc32Hex(data),
		client:     &http.Client{Timeout: 15 * time.Minute},
		tdid:       tdid,
	}, nil
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}

func (j *JianYingASR) cacheKey() string { return "JianYingASR-" + j.crcHex }

func (j *JianYingASR) Run() (Data, error) {
	if err := j.upload(); err != nil {
		return Data{}, err
	}
	queryID, err := j.submit()
	if err != nil {
		return Data{}, err
	}
	resp, err := j.query(queryID)
	if err != nil {
		return Data{}, err
	}
	var segs []Segment
	for _, u := range resp.Data.Utterances {
		segs = append(segs, Segment{Text: u.Text, StartTime: u.StartTime, EndTime: u.EndTime})
	}
	return Data{Segments: segs}, nil
}

type jyUtterance struct {
	Text      string  `json:"text"`
	StartTime float64 `json:"start_time"`
	EndTime   float64 `json:"end_time"`
}

type jyQueryResp struct {
	Data struct {
		Utterances []jyUtterance `json:"utterances"`
	} `json:"data"`
}

func (j *JianYingASR) sign(path string) (string, string, error) {
	current := fmt.Sprintf("%d", time.Now().Unix())
	payload, _ := json.Marshal(map[string]string{
		"url": path, "current_time": current, "pf": "4", "appvr": "4.0.0", "tdid": j.tdid,
	})
	req, _ := http.NewRequest(http.MethodPost, "https://asrtools-update.bkfeng.top/sign", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := j.client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("剪映签名服务请求失败: %w", err)
	}
	defer resp.Body.Close()
	var body struct {
		Sign string `json:"sign"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Sign == "" {
		return "", "", fmt.Errorf("剪映签名服务返回无效数据")
	}
	return strings.ToLower(body.Sign), current, nil
}

func (j *JianYingASR) headers(deviceTime, sign string) map[string]string {
	return map[string]string{
		"User-Agent":  "Cronet/TTNetVersion:01594da2 2023-03-14 QuicVersion:46688bb4 2022-11-28",
		"appvr":       "4.0.0",
		"device-time": deviceTime,
		"pf":          "4",
		"sign":        sign,
		"sign-ver":    "1",
		"tdid":        j.tdid,
	}
}

func (j *JianYingASR) upload() error {
	sign, deviceTime, err := j.sign("/lv/v1/upload_sign")
	if err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodPost, "https://lv-pc-api-sinfonlinec.ulikecam.com/lv/v1/upload_sign", strings.NewReader(`{"biz":"pc-recognition"}`))
	for k, v := range j.headers(deviceTime, sign) {
		req.Header.Set(k, v)
	}
	resp, err := j.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var login struct {
		Data struct {
			AccessKeyID     string `json:"access_key_id"`
			SecretAccessKey string `json:"secret_access_key"`
			SessionToken    string `json:"session_token"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&login); err != nil {
		return err
	}
	j.accessKey = login.Data.AccessKeyID
	j.secretKey = login.Data.SecretAccessKey
	j.sessionToken = login.Data.SessionToken

	params := fmt.Sprintf("Action=ApplyUploadInner&FileSize=%d&FileType=object&IsInner=1&SpaceName=lv-mac-recognition&Version=2020-11-19&s=5y0udbjapi", len(j.fileBinary))
	amzDate := time.Now().UTC().Format("20060102T150405Z")
	dateStamp := amzDate[:8]
	headers := map[string]string{
		"x-amz-date":           amzDate,
		"x-amz-security-token": j.sessionToken,
	}
	signature := awsV4Sign(j.secretKey, params, headers, "GET", "", "cn", "vod")
	headers["authorization"] = fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s/cn/vod/aws4_request, SignedHeaders=x-amz-date;x-amz-security-token, Signature=%s",
		j.accessKey, dateStamp, signature,
	)
	authReq, _ := http.NewRequest(http.MethodGet, "https://vod.bytedanceapi.com/?"+params, nil)
	for k, v := range headers {
		authReq.Header.Set(k, v)
	}
	authResp, err := j.client.Do(authReq)
	if err != nil {
		return err
	}
	defer authResp.Body.Close()
	var store struct {
		Result struct {
			UploadAddress struct {
				StoreInfos []struct {
					StoreUri string `json:"StoreUri"`
					Auth     string `json:"Auth"`
					UploadID string `json:"UploadID"`
				} `json:"StoreInfos"`
				UploadHosts []string `json:"UploadHosts"`
			} `json:"UploadAddress"`
		} `json:"Result"`
	}
	if err := json.NewDecoder(authResp.Body).Decode(&store); err != nil {
		return err
	}
	if len(store.Result.UploadAddress.StoreInfos) == 0 || len(store.Result.UploadAddress.UploadHosts) == 0 {
		return fmt.Errorf("剪映上传地址无效")
	}
	info := store.Result.UploadAddress.StoreInfos[0]
	j.storeURI = info.StoreUri
	j.auth = info.Auth
	j.uploadID = info.UploadID
	j.uploadHost = store.Result.UploadAddress.UploadHosts[0]

	putURL := fmt.Sprintf("https://%s/%s?partNumber=1&uploadID=%s", j.uploadHost, j.storeURI, j.uploadID)
	putReq, _ := http.NewRequest(http.MethodPut, putURL, bytes.NewReader(j.fileBinary))
	putReq.Header.Set("Authorization", j.auth)
	putReq.Header.Set("Content-CRC32", j.crcHex)
	putResp, err := j.client.Do(putReq)
	if err != nil {
		return err
	}
	putResp.Body.Close()

	checkURL := fmt.Sprintf("https://%s/%s?uploadID=%s", j.uploadHost, j.storeURI, j.uploadID)
	checkReq, _ := http.NewRequest(http.MethodPost, checkURL, strings.NewReader("1:"+j.crcHex))
	checkReq.Header.Set("Authorization", j.auth)
	checkReq.Header.Set("Content-CRC32", j.crcHex)
	checkResp, err := j.client.Do(checkReq)
	if err != nil {
		return err
	}
	checkResp.Body.Close()
	return nil
}

func (j *JianYingASR) submit() (string, error) {
	sign, deviceTime, err := j.sign("/lv/v1/audio_subtitle/submit")
	if err != nil {
		return "", err
	}
	payload, _ := json.Marshal(map[string]any{
		"adjust_endtime": 200, "audio": j.storeURI, "caption_type": 2,
		"client_request_id": "45faf98c-160f-4fae-a649-6d89b0fe35be",
		"max_lines": 1, "songs_info": []map[string]any{{"end_time": 6000, "id": "", "start_time": 0}},
		"words_per_line": 16,
	})
	req, _ := http.NewRequest(http.MethodPost, "https://lv-pc-api-sinfonlinec.ulikecam.com/lv/v1/audio_subtitle/submit", bytes.NewReader(payload))
	for k, v := range j.headers(deviceTime, sign) {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := j.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var body struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	return body.Data.ID, nil
}

func (j *JianYingASR) query(id string) (jyQueryResp, error) {
	sign, deviceTime, err := j.sign("/lv/v1/audio_subtitle/query")
	if err != nil {
		return jyQueryResp{}, err
	}
	payload, _ := json.Marshal(map[string]any{"id": id, "pack_options": map[string]any{"need_attribute": true}})
	req, _ := http.NewRequest(http.MethodPost, "https://lv-pc-api-sinfonlinec.ulikecam.com/lv/v1/audio_subtitle/query", bytes.NewReader(payload))
	for k, v := range j.headers(deviceTime, sign) {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := j.client.Do(req)
	if err != nil {
		return jyQueryResp{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out jyQueryResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return jyQueryResp{}, err
	}
	return out, nil
}

func awsV4Sign(secretKey, query string, headers map[string]string, method, payload, region, service string) string {
	canonicalHeaders := ""
	var keys []string
	for k := range headers {
		keys = append(keys, k)
	}
	// fixed order for the two headers we use
	for _, k := range []string{"x-amz-date", "x-amz-security-token"} {
		canonicalHeaders += k + ":" + headers[k] + "\n"
	}
	signedHeaders := "x-amz-date;x-amz-security-token"
	payloadHash := sha256Hex(payload)
	canonicalRequest := strings.Join([]string{
		method, "/", query, canonicalHeaders, signedHeaders, payloadHash,
	}, "\n")
	amzDate := headers["x-amz-date"]
	dateStamp := strings.Split(amzDate, "T")[0]
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, dateStamp + "/" + region + "/" + service + "/aws4_request",
		sha256Hex(canonicalRequest),
	}, "\n")
	signingKey := getSignatureKey(secretKey, dateStamp, region, service)
	return hmacSHA256Hex(signingKey, stringToSign)
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", sum[:])
}

func hmacSHA256Hex(key []byte, msg string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return fmt.Sprintf("%x", m.Sum(nil))
}

func signKey(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}

func getSignatureKey(secret, dateStamp, region, service string) []byte {
	kDate := signKey([]byte("AWS4"+secret), dateStamp)
	kRegion := signKey(kDate, region)
	kService := signKey(kRegion, service)
	return signKey(kService, "aws4_request")
}