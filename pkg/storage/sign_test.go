package storage

import (
	"strings"
	"testing"
)

func TestCanonicalCoverKey(t *testing.T) {
	PublicURLBase = "https://soul.lingecho.com"
	cases := []struct {
		in   string
		want string
	}{
		{
			"https://soul.lingecho.com/covers/sz35b44/1795146433937185000.jpg?e=1795355125&token=abc:def",
			"covers/sz35b44/1795146433937185000.jpg",
		},
		{
			"https://soul.lingecho.com/covers/sz35b44/1795146433937185000.jpg",
			"covers/sz35b44/1795146433937185000.jpg",
		},
		{
			"/api/v1/media?key=covers%2Fsz35b44%2Fx.jpg&exp=1&sig=abc",
			"covers/sz35b44/x.jpg",
		},
		{
			"covers/sz35b44/x.jpg",
			"covers/sz35b44/x.jpg",
		},
		{
			"https://cdn.example.com/other.jpg?token=1",
			"",
		},
		{
			"data:image/png;base64,aaa",
			"",
		},
	}
	for _, tc := range cases {
		got := CanonicalCoverKey(tc.in)
		if got != tc.want {
			t.Fatalf("CanonicalCoverKey(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
}

func TestResolveAccessURLDoesNotLeakExpiredToken(t *testing.T) {
	PublicURLBase = "https://soul.lingecho.com"
	SignSecret = []byte("test-secret-for-sign")
	Store = nil // SignedURL fails without Store
	expired := "https://soul.lingecho.com/covers/a/b.jpg?e=1&token=dead"
	got := ResolveAccessURL(expired, DisplayURLTTL)
	if strings.Contains(got, "token=") {
		t.Fatalf("ResolveAccessURL leaked expired token: %q", got)
	}
}
