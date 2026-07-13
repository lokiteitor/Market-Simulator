package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// fakeClient simula el backend: el refresh token es de un solo uso (rotación),
// así que un token ya rotado por otro proceso es rechazado para siempre.
type fakeClient struct {
	logins       int
	validRefresh string
}

func (f *fakeClient) Login(ctx context.Context, req models.LoginRequest) (*models.TokenPair, error) {
	f.logins++
	f.validRefresh = "refresh-from-login"
	return &models.TokenPair{
		AccessToken:      "access-from-login",
		RefreshToken:     f.validRefresh,
		AccessExpiresAt:  time.Now().Add(15 * time.Minute),
		RefreshExpiresAt: time.Now().Add(7 * 24 * time.Hour),
	}, nil
}

func (f *fakeClient) refresh(ctx context.Context, refreshToken string) (*models.TokenPair, error) {
	if refreshToken != f.validRefresh {
		return nil, errors.New("API error (status 401): Refresh token desconocido, expirado o revocado")
	}
	f.validRefresh = "refresh-rotated"
	return &models.TokenPair{
		AccessToken:      "access-from-refresh",
		RefreshToken:     f.validRefresh,
		AccessExpiresAt:  time.Now().Add(15 * time.Minute),
		RefreshExpiresAt: time.Now().Add(7 * 24 * time.Hour),
	}, nil
}

func (f *fakeClient) Register(ctx context.Context, req models.RegisterAgentRequest) (*models.RegisterAgentResponse, error) {
	return nil, errors.New("not used")
}

func (f *fakeClient) GetAgentSnapshot(ctx context.Context, eventsLimit int) (*models.AgentSnapshot, error) {
	return nil, errors.New("not used")
}

// Un refresh token revocado (rotado por otro proceso con el mismo fichero de
// sesión) no debe dejar al agente inservible: reautentica con user/password.
func TestGetAccessTokenFallsBackToLoginWhenRefreshIsRevoked(t *testing.T) {
	client := &fakeClient{validRefresh: "refresh-owned-by-another-process"}

	a := NewAuthManager("bot_1", "pw", models.AgentRole("consumer"), "")
	a.SetRefresher(client.refresh)
	a.SetLoginHelper(client)
	a.accessToken = "expired-access"
	a.refreshToken = "refresh-already-revoked"
	a.accessExp = time.Now().Add(-time.Second)
	a.refreshExp = time.Now().Add(7 * 24 * time.Hour)

	token, err := a.GetAccessToken(context.Background())
	if err != nil {
		t.Fatalf("GetAccessToken: %v", err)
	}
	if token != "access-from-login" {
		t.Fatalf("got token %q, want the one issued by the re-login", token)
	}
	if client.logins != 1 {
		t.Fatalf("got %d logins, want exactly 1", client.logins)
	}

	// La sesión queda usable: el siguiente ciclo refresca con el token nuevo.
	a.accessExp = time.Now().Add(-time.Second)
	token, err = a.GetAccessToken(context.Background())
	if err != nil {
		t.Fatalf("GetAccessToken after re-login: %v", err)
	}
	if token != "access-from-refresh" || client.logins != 1 {
		t.Fatalf("got token %q after %d logins, want a plain refresh", token, client.logins)
	}
}

// InvalidateAccessToken descarta un token que localmente parece válido (p.ej.
// el servidor lo rechazó con 401 tras rotar el secreto JWT): la siguiente
// llamada debe obtener uno fresco en vez de devolver el cacheado.
func TestInvalidateAccessTokenForcesRefresh(t *testing.T) {
	client := &fakeClient{validRefresh: "refresh-valid"}

	a := NewAuthManager("bot_1", "pw", models.AgentRole("consumer"), "")
	a.SetRefresher(client.refresh)
	a.SetLoginHelper(client)
	a.accessToken = "stale-but-locally-valid"
	a.refreshToken = "refresh-valid"
	a.accessExp = time.Now().Add(10 * time.Minute)
	a.tokenTTL = 15 * time.Minute
	a.refreshExp = time.Now().Add(7 * 24 * time.Hour)

	a.InvalidateAccessToken()

	token, err := a.GetAccessToken(context.Background())
	if err != nil {
		t.Fatalf("GetAccessToken: %v", err)
	}
	if token != "access-from-refresh" {
		t.Fatalf("got token %q, want a freshly refreshed one", token)
	}
}

// Con tokens de vida corta el buffer se recorta a un tercio del TTL: un token
// recién emitido no debe refrescarse (y rotar el refresh token) en cada request.
func TestRefreshBufferClampedForShortLivedTokens(t *testing.T) {
	client := &fakeClient{validRefresh: "refresh-valid"}

	a := NewAuthManager("bot_1", "pw", models.AgentRole("consumer"), "")
	a.SetRefresher(client.refresh)
	a.SetLoginHelper(client)
	a.storeTokensLocked("short-lived-access", "refresh-valid",
		time.Now().Add(30*time.Second), time.Now().Add(7*24*time.Hour))

	token, err := a.GetAccessToken(context.Background())
	if err != nil {
		t.Fatalf("GetAccessToken: %v", err)
	}
	if token != "short-lived-access" {
		t.Fatalf("got token %q, want the cached one (no premature refresh)", token)
	}
}
