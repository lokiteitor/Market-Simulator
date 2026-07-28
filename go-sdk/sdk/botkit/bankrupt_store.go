package botkit

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// BankruptStore recuerda EN DISCO los agentes que el servidor confirmó en
// quiebra (ADR-026), para que sobrevivan al reinicio del runner.
//
// Sin esta persistencia la lista de quebrados vivía solo en la memoria del
// proceso: al relanzar el enjambre contra la misma base de datos, todas las
// cuentas muertas volvían a la rotación, su login devolvía 403 agent_bankrupt
// —lo hace para siempre, authService.login rechaza a los quebrados— y cada
// turno de cada una gastaba un arranque completo (login + registro fallido)
// para acabar en el log. Con miles de bots eso es una inundación de errores y
// de carga inútil contra el Core.
//
// El fichero es una lista de usernames, uno por línea, append-only:
//
//	# bots quebrados (ADR-026)
//	d47cb619-743b-5b3b-b346-7c743941c52d
//
// Los usernames son deterministas (UUID v5 desde --runner-id), así que el
// fichero solo es válido mientras la base de datos sea la misma: tras un
// `make clean-docker` hay que borrarlo (las cuentas ya no existen y son
// registrables de nuevo). `make clean-docker` lo borra.
type BankruptStore struct {
	mu   sync.Mutex
	path string // "" = solo memoria (modo -no-persist)
	dead map[string]struct{}
}

// NewBankruptStore abre (o crea implícitamente) el registro en `path` y carga
// lo que ya hubiera. Con `path` vacío el store funciona solo en memoria. El
// store devuelto es siempre usable: un error de lectura se reporta pero no
// impide arrancar (se empieza con la lista vacía, que es el comportamiento
// previo a la persistencia).
func NewBankruptStore(path string) (*BankruptStore, error) {
	s := &BankruptStore{path: path, dead: make(map[string]struct{})}
	if path == "" {
		return s, nil
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return s, fmt.Errorf("no se pudo crear el directorio de %s: %w", path, err)
		}
	}

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil // primera corrida: aún no hay quebrados
		}
		return s, fmt.Errorf("no se pudo leer %s: %w", path, err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		s.dead[line] = struct{}{}
	}
	if err := scanner.Err(); err != nil {
		return s, fmt.Errorf("no se pudo leer %s: %w", path, err)
	}
	return s, nil
}

// Has indica si el agente ya está retirado por quiebra.
func (s *BankruptStore) Has(username string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.dead[username]
	return ok
}

// Add registra la quiebra y la persiste. Devuelve el total acumulado (incluido
// lo cargado de corridas anteriores) y el error de escritura, si lo hubo: el
// registro en memoria se actualiza igualmente, así que un disco lleno degrada
// a "solo esta corrida" en vez de romper el runner. Es idempotente.
func (s *BankruptStore) Add(username string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.dead[username]; ok {
		return len(s.dead), nil
	}
	s.dead[username] = struct{}{}
	total := len(s.dead)

	if s.path == "" {
		return total, nil
	}
	f, err := os.OpenFile(s.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return total, fmt.Errorf("no se pudo abrir %s: %w", s.path, err)
	}
	defer f.Close()
	// Una línea corta con O_APPEND es una escritura atómica: varios runners
	// sobre el mismo fichero no se pisan.
	if _, err := f.WriteString(username + "\n"); err != nil {
		return total, fmt.Errorf("no se pudo escribir en %s: %w", s.path, err)
	}
	return total, nil
}

// Total devuelve cuántos agentes hay retirados.
func (s *BankruptStore) Total() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.dead)
}

// Path devuelve el fichero de respaldo ("" si el store es solo memoria).
func (s *BankruptStore) Path() string {
	return s.path
}
