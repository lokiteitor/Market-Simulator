package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

type LoginHelper interface {
	Login(ctx context.Context, req models.LoginRequest) (*models.TokenPair, error)
	Register(ctx context.Context, req models.RegisterAgentRequest) (*models.RegisterAgentResponse, error)
	GetAgentSnapshot(ctx context.Context, eventsLimit int) (*models.AgentSnapshot, error)
}

type SessionData struct {
	Username         string           `json:"username"`
	Password         string           `json:"password"`
	Role             models.AgentRole `json:"role"`
	AgentID          string           `json:"agent_id"`
	AccessToken      string           `json:"access_token"`
	RefreshToken     string           `json:"refresh_token"`
	AccessExpiresAt  time.Time        `json:"access_expires_at"`
	RefreshExpiresAt time.Time        `json:"refresh_expires_at"`
}

type AuthManager struct {
	sync.RWMutex
	username     string
	password     string
	role         models.AgentRole
	agentID      string
	accessToken  string
	refreshToken string
	accessExp    time.Time
	refreshExp   time.Time

	persistPath string
	refresher   func(ctx context.Context, refreshToken string) (*models.TokenPair, error)
	loginHelper LoginHelper
}

func NewAuthManager(username, password string, role models.AgentRole, persistPath string) *AuthManager {
	return &AuthManager{
		username:    username,
		password:    password,
		role:        role,
		persistPath: persistPath,
	}
}

func (a *AuthManager) SetRefresher(refresher func(ctx context.Context, refreshToken string) (*models.TokenPair, error)) {
	a.Lock()
	defer a.Unlock()
	a.refresher = refresher
}

// SetLoginHelper configures the client used to re-authenticate from scratch when a
// refresh token is rejected (rotated by another process, revoked or expired).
func (a *AuthManager) SetLoginHelper(client LoginHelper) {
	a.Lock()
	defer a.Unlock()
	a.loginHelper = client
}

func (a *AuthManager) GetAgentID() string {
	a.RLock()
	defer a.RUnlock()
	return a.agentID
}

func (a *AuthManager) GetRole() models.AgentRole {
	a.RLock()
	defer a.RUnlock()
	return a.role
}

func (a *AuthManager) GetUsername() string {
	a.RLock()
	defer a.RUnlock()
	return a.username
}

func (a *AuthManager) GetAccessToken(ctx context.Context) (string, error) {
	a.Lock()
	defer a.Unlock()

	if a.accessToken == "" {
		return "", errors.New("no access token available, authentication required")
	}

	// Check if access token is expired or close to expiration (30 seconds buffer)
	if time.Now().Add(30 * time.Second).After(a.accessExp) {
		refreshErr := a.refreshLocked(ctx)
		if refreshErr == nil {
			return a.accessToken, nil
		}

		// The refresh token is single-use: the server rotates and revokes it on every
		// refresh, so it can be rejected for good (e.g. another process using the same
		// session file rotated it first). Falling back to a full login is the only way
		// out; without it the agent would fail every request until restarted.
		if err := a.loginLocked(ctx); err != nil {
			return "", fmt.Errorf("failed to auto-refresh access token: %w (re-login failed: %v)", refreshErr, err)
		}
	}

	return a.accessToken, nil
}

// refreshLocked exchanges the current refresh token for a new token pair.
// The caller must hold the write lock.
func (a *AuthManager) refreshLocked(ctx context.Context) error {
	if a.refreshToken == "" {
		return errors.New("no refresh token available")
	}
	if a.refresher == nil {
		return errors.New("token refresher function is not configured")
	}

	tokens, err := a.refresher(ctx, a.refreshToken)
	if err != nil {
		return err
	}
	a.storeTokensLocked(tokens.AccessToken, tokens.RefreshToken, tokens.AccessExpiresAt, tokens.RefreshExpiresAt)
	return nil
}

// loginLocked re-authenticates with the stored credentials, discarding the current
// tokens. The caller must hold the write lock; LoginHelper.Login is unauthenticated,
// so it does not re-enter GetAccessToken.
func (a *AuthManager) loginLocked(ctx context.Context) error {
	if a.loginHelper == nil {
		return errors.New("login helper is not configured")
	}

	tokens, err := a.loginHelper.Login(ctx, models.LoginRequest{
		Username: a.username,
		Password: a.password,
	})
	if err != nil {
		return err
	}
	a.storeTokensLocked(tokens.AccessToken, tokens.RefreshToken, tokens.AccessExpiresAt, tokens.RefreshExpiresAt)
	return nil
}

func (a *AuthManager) storeTokensLocked(accessToken, refreshToken string, accessExp, refreshExp time.Time) {
	a.accessToken = accessToken
	a.refreshToken = refreshToken
	a.accessExp = accessExp
	a.refreshExp = refreshExp
	_ = a.saveSessionLocked()
}

// PerformAuth handles the authentication flow: loading from disk, attempting refresh, login or register.
func (a *AuthManager) PerformAuth(ctx context.Context, client LoginHelper, autoRegister bool, requestedCapacities []models.RequestedCapacity) error {
	a.Lock()
	defer a.Unlock()

	// Keep the helper around so GetAccessToken can re-login on its own when a
	// refresh token is rejected mid-run.
	a.loginHelper = client

	// 1. Try to load from persistence
	loaded := a.loadSessionLocked()
	if loaded && a.refreshToken != "" && time.Now().Before(a.refreshExp) {
		// Attempt refresh; if it fails, fall through to login/register
		if err := a.refreshLocked(ctx); err == nil {
			return nil
		}
	}

	// 2. Refresh failed or no session, attempt Login
	loginReq := models.LoginRequest{
		Username: a.username,
		Password: a.password,
	}

	tokens, err := client.Login(ctx, loginReq)
	if err == nil {
		a.accessToken = tokens.AccessToken
		a.refreshToken = tokens.RefreshToken
		a.accessExp = tokens.AccessExpiresAt
		a.refreshExp = tokens.RefreshExpiresAt

		// Need to get agent snapshot to obtain agent ID and role
		// temporarily unlock to make the API call because client calls will trigger GetAccessToken which needs the read/write lock.
		// Wait, if we are in PerformAuth, c.do(...) will call GetAccessToken, but since we have a.accessToken populated, it will work.
		// However, to avoid deadlock since c.do() will call GetAccessToken which calls a.Lock(), we MUST unlock here before making the API call!
		a.Unlock()
		snapshot, err := client.GetAgentSnapshot(ctx, 1)
		a.Lock()

		if err != nil {
			return fmt.Errorf("failed to retrieve agent snapshot after login: %w", err)
		}

		a.agentID = snapshot.Agent.AgentID
		a.role = snapshot.Agent.Role
		_ = a.saveSessionLocked()
		return nil
	}

	// 3. Login failed; check if we should auto-register
	if autoRegister {
		regReq := models.RegisterAgentRequest{
			Username:            a.username,
			Password:            a.password,
			Role:                a.role,
			RequestedCapacities: requestedCapacities,
		}
		a.Unlock()
		regResp, err := client.Register(ctx, regReq)
		a.Lock()
		if err != nil {
			return fmt.Errorf("auto-registration failed: %w", err)
		}

		a.accessToken = regResp.AccessToken
		a.refreshToken = regResp.RefreshToken
		a.accessExp = regResp.AccessExpiresAt
		a.refreshExp = regResp.RefreshExpiresAt
		a.agentID = regResp.Agent.Agent.AgentID
		a.role = regResp.Agent.Agent.Role

		_ = a.saveSessionLocked()
		return nil
	}

	return fmt.Errorf("authentication failed: %w", err)
}

func (a *AuthManager) loadSessionLocked() bool {
	if a.persistPath == "" {
		return false
	}
	f, err := os.Open(a.persistPath)
	if err != nil {
		return false
	}
	defer f.Close()

	var data SessionData
	if err := json.NewDecoder(f).Decode(&data); err != nil {
		return false
	}

	// Only restore if the username matches
	if data.Username != a.username {
		return false
	}

	a.password = data.Password
	a.role = data.Role
	a.agentID = data.AgentID
	a.accessToken = data.AccessToken
	a.refreshToken = data.RefreshToken
	a.accessExp = data.AccessExpiresAt
	a.refreshExp = data.RefreshExpiresAt
	return true
}

func (a *AuthManager) saveSessionLocked() error {
	if a.persistPath == "" {
		return nil
	}
	// Create directory if not exists
	dir := filepath.Dir(a.persistPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data := SessionData{
		Username:         a.username,
		Password:         a.password,
		Role:             a.role,
		AgentID:          a.agentID,
		AccessToken:      a.accessToken,
		RefreshToken:     a.refreshToken,
		AccessExpiresAt:  a.accessExp,
		RefreshExpiresAt: a.refreshExp,
	}

	// Write to temp file and rename to avoid partial writes
	tmpFile := a.persistPath + ".tmp"
	f, err := os.OpenFile(tmpFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer func() {
		f.Close()
		_ = os.Remove(tmpFile)
	}()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	f.Close()

	return os.Rename(tmpFile, a.persistPath)
}

func (a *AuthManager) ClearSession() error {
	a.Lock()
	defer a.Unlock()
	a.accessToken = ""
	a.refreshToken = ""
	a.accessExp = time.Time{}
	a.refreshExp = time.Time{}
	if a.persistPath != "" {
		return os.Remove(a.persistPath)
	}
	return nil
}
