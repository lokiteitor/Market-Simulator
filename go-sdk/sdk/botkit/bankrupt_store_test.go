package botkit

import (
	"os"
	"path/filepath"
	"testing"
)

// El registro de quebrados existe para sobrevivir al reinicio del runner: sin
// esto, cada arranque reintenta cuentas cuyo login devuelve 403 agent_bankrupt
// para siempre (ADR-026).
func TestBankruptStorePersistsAcrossRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "bankrupt.list")

	s, err := NewBankruptStore(path)
	if err != nil {
		t.Fatalf("NewBankruptStore: %v", err)
	}
	if s.Has("bot-a") {
		t.Fatal("un store nuevo no debería tener nada")
	}
	if n, err := s.Add("bot-a"); err != nil || n != 1 {
		t.Fatalf("Add(bot-a) = %d, %v; want 1, nil", n, err)
	}
	// Idempotente: la misma quiebra no se cuenta ni se escribe dos veces.
	if n, err := s.Add("bot-a"); err != nil || n != 1 {
		t.Fatalf("Add(bot-a) repetido = %d, %v; want 1, nil", n, err)
	}
	if n, err := s.Add("bot-b"); err != nil || n != 2 {
		t.Fatalf("Add(bot-b) = %d, %v; want 2, nil", n, err)
	}

	// Reinicio del runner: otro store sobre el mismo fichero.
	reloaded, err := NewBankruptStore(path)
	if err != nil {
		t.Fatalf("NewBankruptStore (recarga): %v", err)
	}
	if !reloaded.Has("bot-a") || !reloaded.Has("bot-b") {
		t.Fatal("la recarga perdió quebrados")
	}
	if reloaded.Has("bot-c") {
		t.Fatal("la recarga inventó un quebrado")
	}
	if got := reloaded.Total(); got != 2 {
		t.Fatalf("Total() = %d, want 2", got)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "bot-a\nbot-b\n" {
		t.Fatalf("contenido %q, want \"bot-a\\nbot-b\\n\"", data)
	}
}

// Con -no-persist (path vacío) el store funciona solo en memoria y no toca
// disco: es el mismo comportamiento que tenía el runner antes.
func TestBankruptStoreMemoryOnly(t *testing.T) {
	s, err := NewBankruptStore("")
	if err != nil {
		t.Fatalf("NewBankruptStore(\"\"): %v", err)
	}
	if n, err := s.Add("bot-a"); err != nil || n != 1 {
		t.Fatalf("Add = %d, %v; want 1, nil", n, err)
	}
	if !s.Has("bot-a") {
		t.Fatal("el store en memoria no recordó la quiebra")
	}
	if s.Path() != "" {
		t.Fatalf("Path() = %q, want \"\"", s.Path())
	}
}

// Un fichero ilegible no puede impedir arrancar el enjambre: se reporta el
// error y se sigue con la lista vacía (el comportamiento previo).
func TestBankruptStoreUsableAfterLoadError(t *testing.T) {
	dir := t.TempDir()
	// Un directorio donde se espera un fichero: os.Open funciona, el Read falla.
	path := filepath.Join(dir, "soy-un-directorio")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}

	s, err := NewBankruptStore(path)
	if err == nil {
		t.Fatal("NewBankruptStore no reportó el error de lectura")
	}
	if s == nil {
		t.Fatal("NewBankruptStore devolvió un store nil: el runner no podría arrancar")
	}
	if s.Has("bot-a") || s.Total() != 0 {
		t.Fatal("el store degradado debería empezar vacío")
	}
}
