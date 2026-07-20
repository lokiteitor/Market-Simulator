package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/models"
	_ "modernc.org/sqlite"
)

// The access token is refreshed proactively when it is within this buffer of
// expiring. The buffer must absorb moderate clock skew between the bot and the
// server; a per-manager random jitter spreads the refreshes of many bots
// running in the same process so they don't all hit /auth/refresh at once.
const (
	refreshBufferBase   = 60 * time.Second
	refreshBufferJitter = 30 * time.Second
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

// memorySessions conserva las sesiones en RAM cuando no hay persistencia en
// disco (persistPath == ""), compartidas entre todos los AuthManager del
// proceso: las re-activaciones de un bot (rotación del swarm con -no-persist)
// reutilizan la cadena de refresh tokens en vez de pagar un login con argon2
// en el servidor por cada activación. Coste: ~1 KiB por bot que haya estado
// activo alguna vez en la vida del proceso.
var memorySessions sync.Map // username → SessionData

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
	tokenTTL     time.Duration

	persistPath   string
	refreshBuffer time.Duration
	refresher     func(ctx context.Context, refreshToken string) (*models.TokenPair, error)
	loginHelper   LoginHelper
}

func NewAuthManager(username, password string, role models.AgentRole, persistPath string) *AuthManager {
	return &AuthManager{
		username:      username,
		password:      password,
		role:          role,
		persistPath:   persistPath,
		refreshBuffer: refreshBufferBase + rand.N(refreshBufferJitter),
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

	// Check if access token is expired or close to expiration
	if time.Now().Add(a.bufferLocked()).After(a.accessExp) {
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

// bufferLocked returns the proactive-refresh buffer for the current token,
// clamped to a third of the token's TTL so short-lived tokens don't trigger a
// refresh (and a refresh-token rotation) on every single request.
func (a *AuthManager) bufferLocked() time.Duration {
	if a.tokenTTL > 0 && a.tokenTTL/3 < a.refreshBuffer {
		return a.tokenTTL / 3
	}
	return a.refreshBuffer
}

// InvalidateAccessToken discards the cached access token so the next
// GetAccessToken call obtains a fresh one (refresh or re-login). Callers use
// it when the server rejects the token with a 401 even though it has not
// expired locally (revoked session, rotated JWT secret, clock skew).
func (a *AuthManager) InvalidateAccessToken() {
	a.Lock()
	defer a.Unlock()
	a.accessExp = time.Time{}
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
	a.tokenTTL = time.Until(accessExp)
	_ = a.saveSessionLocked()
}

// PerformAuth handles the authentication flow: loading from disk, attempting refresh, login or register.
func (a *AuthManager) PerformAuth(ctx context.Context, client LoginHelper, autoRegister bool) error {
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
		a.storeTokensLocked(tokens.AccessToken, tokens.RefreshToken, tokens.AccessExpiresAt, tokens.RefreshExpiresAt)

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
			Username: a.username,
			Password: a.password,
			Role:     a.role,
		}
		a.Unlock()
		regResp, err := client.Register(ctx, regReq)
		a.Lock()
		if err != nil {
			return fmt.Errorf("auto-registration failed: %w", err)
		}

		a.agentID = regResp.Agent.Agent.AgentID
		a.role = regResp.Agent.Agent.Role
		a.storeTokensLocked(regResp.AccessToken, regResp.RefreshToken, regResp.AccessExpiresAt, regResp.RefreshExpiresAt)
		return nil
	}

	return fmt.Errorf("authentication failed: %w", err)
}

func resolveSQLitePath(persistPath string) string {
	if persistPath == "" {
		return ""
	}
	ext := filepath.Ext(persistPath)
	if ext == ".sqlite" || ext == ".db" {
		return persistPath
	}
	dir := filepath.Dir(persistPath)
	return filepath.Join(dir, "sessions.sqlite")
}

func (a *AuthManager) loadSessionLocked() bool {
	if a.persistPath == "" {
		v, ok := memorySessions.Load(a.username)
		if !ok {
			return false
		}
		data := v.(SessionData)
		a.password = data.Password
		a.role = data.Role
		a.agentID = data.AgentID
		a.accessToken = data.AccessToken
		a.refreshToken = data.RefreshToken
		a.accessExp = data.AccessExpiresAt
		a.refreshExp = data.RefreshExpiresAt
		a.tokenTTL = time.Until(data.AccessExpiresAt)
		return true
	}

	dbPath := resolveSQLitePath(a.persistPath)
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return false
	}

	db, err := sql.Open("sqlite", dbPath+"?_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return false
	}
	defer db.Close()

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS sessions (
		username TEXT PRIMARY KEY,
		password TEXT,
		role TEXT,
		agent_id TEXT,
		access_token TEXT,
		refresh_token TEXT,
		access_expires_at TEXT,
		refresh_expires_at TEXT
	)`)
	if err != nil {
		return false
	}

	var password, role, agentID, accessToken, refreshToken string
	var accessExpiresStr, refreshExpiresStr string

	err = db.QueryRow(`SELECT password, role, agent_id, access_token, refresh_token, access_expires_at, refresh_expires_at 
		FROM sessions WHERE username = ?`, a.username).Scan(
		&password, &role, &agentID, &accessToken, &refreshToken, &accessExpiresStr, &refreshExpiresStr,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) && strings.HasSuffix(a.persistPath, ".json") {
			if f, jsonErr := os.Open(a.persistPath); jsonErr == nil {
				var data SessionData
				if decErr := json.NewDecoder(f).Decode(&data); decErr == nil && data.Username == a.username {
					f.Close()
					_, saveErr := db.Exec(`INSERT OR REPLACE INTO sessions 
						(username, password, role, agent_id, access_token, refresh_token, access_expires_at, refresh_expires_at) 
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						data.Username, data.Password, data.Role, data.AgentID,
						data.AccessToken, data.RefreshToken,
						data.AccessExpiresAt.Format(time.RFC3339),
						data.RefreshExpiresAt.Format(time.RFC3339),
					)
					if saveErr == nil {
						_ = os.Remove(a.persistPath)
						return a.loadSessionLocked()
					}
				} else {
					f.Close()
				}
			}
		}
		return false
	}

	accessExp, err := time.Parse(time.RFC3339, accessExpiresStr)
	if err != nil {
		return false
	}
	refreshExp, err := time.Parse(time.RFC3339, refreshExpiresStr)
	if err != nil {
		return false
	}

	a.password = password
	a.role = models.AgentRole(role)
	a.agentID = agentID
	a.accessToken = accessToken
	a.refreshToken = refreshToken
	a.accessExp = accessExp
	a.refreshExp = refreshExp
	a.tokenTTL = time.Until(accessExp)
	return true
}

func (a *AuthManager) saveSessionLocked() error {
	if a.persistPath == "" {
		memorySessions.Store(a.username, SessionData{
			Username:         a.username,
			Password:         a.password,
			Role:             a.role,
			AgentID:          a.agentID,
			AccessToken:      a.accessToken,
			RefreshToken:     a.refreshToken,
			AccessExpiresAt:  a.accessExp,
			RefreshExpiresAt: a.refreshExp,
		})
		return nil
	}
	dbPath := resolveSQLitePath(a.persistPath)
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	db, err := sql.Open("sqlite", dbPath+"?_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return err
	}
	defer db.Close()

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS sessions (
		username TEXT PRIMARY KEY,
		password TEXT,
		role TEXT,
		agent_id TEXT,
		access_token TEXT,
		refresh_token TEXT,
		access_expires_at TEXT,
		refresh_expires_at TEXT
	)`)
	if err != nil {
		return err
	}

	_, err = db.Exec(`INSERT OR REPLACE INTO sessions 
		(username, password, role, agent_id, access_token, refresh_token, access_expires_at, refresh_expires_at) 
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		a.username, a.password, a.role, a.agentID,
		a.accessToken, a.refreshToken,
		a.accessExp.Format(time.RFC3339),
		a.refreshExp.Format(time.RFC3339),
	)
	return err
}

func (a *AuthManager) ClearSession() error {
	a.Lock()
	defer a.Unlock()
	a.accessToken = ""
	a.refreshToken = ""
	a.accessExp = time.Time{}
	a.refreshExp = time.Time{}
	a.tokenTTL = 0
	if a.persistPath == "" {
		memorySessions.Delete(a.username)
		return nil
	}
	dbPath := resolveSQLitePath(a.persistPath)
	db, err := sql.Open("sqlite", dbPath+"?_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`DELETE FROM sessions WHERE username = ?`, a.username)
	return err
}
