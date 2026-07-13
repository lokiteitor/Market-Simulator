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
