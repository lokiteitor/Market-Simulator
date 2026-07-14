package auth

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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

func TestSQLiteSessionPersistenceAndMigration(t *testing.T) {
	tempDir := t.TempDir()
	jsonPath := filepath.Join(tempDir, "test_session.json")
	sqlitePath := filepath.Join(tempDir, "sessions.sqlite")

	a := NewAuthManager("test_user", "test_pass", models.AgentRole("trader"), sqlitePath)
	a.agentID = "agent_123"
	a.accessToken = "access_token_123"
	a.refreshToken = "refresh_token_123"
	a.accessExp = time.Now().Add(10 * time.Minute).Round(time.Second)
	a.refreshExp = time.Now().Add(1 * time.Hour).Round(time.Second)

	if err := a.saveSessionLocked(); err != nil {
		t.Fatalf("failed to save session to sqlite: %v", err)
	}

	a2 := NewAuthManager("test_user", "test_pass", models.AgentRole("trader"), sqlitePath)
	if !a2.loadSessionLocked() {
		t.Fatalf("failed to load session from sqlite")
	}

	if a2.password != a.password || a2.agentID != a.agentID || a2.accessToken != a.accessToken || a2.refreshToken != a.refreshToken {
		t.Fatalf("loaded session data does not match saved data")
	}
	if !a2.accessExp.Equal(a.accessExp) || !a2.refreshExp.Equal(a.refreshExp) {
		t.Fatalf("loaded expires at dates do not match")
	}

	if err := a2.ClearSession(); err != nil {
		t.Fatalf("failed to clear session: %v", err)
	}

	a3 := NewAuthManager("test_user", "test_pass", models.AgentRole("trader"), sqlitePath)
	if a3.loadSessionLocked() {
		t.Fatalf("expected loadSessionLocked to fail after ClearSession")
	}

	jsonData := SessionData{
		Username:         "migrated_user",
		Password:         "migrated_pass",
		Role:             models.AgentRole("consumer"),
		AgentID:          "agent_migrated",
		AccessToken:      "access_migrated",
		RefreshToken:     "refresh_migrated",
		AccessExpiresAt:  time.Now().Add(5 * time.Minute).Round(time.Second),
		RefreshExpiresAt: time.Now().Add(30 * time.Minute).Round(time.Second),
	}

	f, err := os.OpenFile(jsonPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatalf("failed to create fake json file: %v", err)
	}
	if err := json.NewEncoder(f).Encode(jsonData); err != nil {
		f.Close()
		t.Fatalf("failed to encode fake json: %v", err)
	}
	f.Close()

	aMigrate := NewAuthManager("migrated_user", "migrated_pass", models.AgentRole("consumer"), jsonPath)
	if !aMigrate.loadSessionLocked() {
		t.Fatalf("failed to load and migrate session from JSON to SQLite")
	}

	if aMigrate.accessToken != "access_migrated" || aMigrate.agentID != "agent_migrated" {
		t.Fatalf("migrated data does not match")
	}

	if _, err := os.Stat(jsonPath); !os.IsNotExist(err) {
		t.Fatalf("expected JSON file to be removed after migration")
	}

	expectedDBPath := filepath.Join(tempDir, "sessions.sqlite")
	aCheck := NewAuthManager("migrated_user", "migrated_pass", models.AgentRole("consumer"), expectedDBPath)
	if !aCheck.loadSessionLocked() {
		t.Fatalf("failed to load migrated session directly from SQLite")
	}
	if aCheck.accessToken != "access_migrated" {
		t.Fatalf("data loaded from SQLite after migration does not match")
	}
}

