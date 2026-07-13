package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeTokenProvider devuelve un token cacheado y, al invalidarlo, entrega uno
// nuevo en la siguiente llamada (simula el refresh/re-login del AuthManager).
type fakeTokenProvider struct {
	tokens        []string
	idx           int
	invalidations int
}

func (f *fakeTokenProvider) GetAccessToken(ctx context.Context) (string, error) {
	return f.tokens[f.idx], nil
}

func (f *fakeTokenProvider) InvalidateAccessToken() {
	f.invalidations++
	if f.idx < len(f.tokens)-1 {
		f.idx++
	}
}

// Un 401 con un token que localmente parece válido (sesión revocada, secreto
// JWT rotado) debe invalidar el token cacheado y reintentar una sola vez.
func TestDoRetriesOnceAfter401(t *testing.T) {
	var seenTokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		seenTokens = append(seenTokens, token)
		if token != "Bearer fresh" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok": true}`))
	}))
	defer server.Close()

	provider := &fakeTokenProvider{tokens: []string{"stale", "fresh"}}
	c := NewClient(server.URL, nil, provider)

	var res map[string]bool
	if err := c.do(context.Background(), http.MethodGet, "/x", nil, &res, true); err != nil {
		t.Fatalf("do: %v", err)
	}
	if provider.invalidations != 1 {
		t.Fatalf("got %d invalidations, want 1", provider.invalidations)
	}
	if len(seenTokens) != 2 || seenTokens[0] != "Bearer stale" || seenTokens[1] != "Bearer fresh" {
		t.Fatalf("got requests with tokens %v, want [Bearer stale, Bearer fresh]", seenTokens)
	}
	if !res["ok"] {
		t.Fatalf("got response %v, want the retried body", res)
	}
}

// Si el 401 persiste con el token nuevo, no se reintenta indefinidamente: el
// error llega al caller tras exactamente un retry.
func TestDoDoesNotRetryTwiceOn401(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	provider := &fakeTokenProvider{tokens: []string{"stale", "still-bad"}}
	c := NewClient(server.URL, nil, provider)

	err := c.do(context.Background(), http.MethodGet, "/x", nil, nil, true)
	if err == nil {
		t.Fatal("do: want error on persistent 401")
	}
	if requests != 2 {
		t.Fatalf("got %d requests, want 2 (original + one retry)", requests)
	}
	if provider.invalidations != 1 {
		t.Fatalf("got %d invalidations, want 1", provider.invalidations)
	}
}

// El body del request debe reenviarse íntegro en el retry.
func TestDoRetryReplaysRequestBody(t *testing.T) {
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 1024)
		n, _ := r.Body.Read(buf)
		bodies = append(bodies, string(buf[:n]))
		if r.Header.Get("Authorization") != "Bearer fresh" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	provider := &fakeTokenProvider{tokens: []string{"stale", "fresh"}}
	c := NewClient(server.URL, nil, provider)

	body := map[string]string{"product_id": "p1"}
	if err := c.do(context.Background(), http.MethodPost, "/x", body, nil, true); err != nil {
		t.Fatalf("do: %v", err)
	}
	if len(bodies) != 2 || bodies[0] != bodies[1] || bodies[0] == "" {
		t.Fatalf("got bodies %q, want the same non-empty body twice", bodies)
	}
}

// Un 401 en un endpoint sin auth (login con credenciales malas) no debe
// disparar invalidación ni retry.
func TestDoNo401RetryOnUnauthenticatedEndpoints(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	provider := &fakeTokenProvider{tokens: []string{"stale"}}
	c := NewClient(server.URL, nil, provider)

	err := c.do(context.Background(), http.MethodPost, "/auth/login", map[string]string{"u": "x"}, nil, false)
	if err == nil {
		t.Fatal("do: want error")
	}
	if requests != 1 || provider.invalidations != 0 {
		t.Fatalf("got %d requests and %d invalidations, want 1 and 0", requests, provider.invalidations)
	}
}
