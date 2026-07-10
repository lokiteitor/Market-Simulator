package main

// configFloat lee una clave numerica del mapa de configuracion de estrategia,
// tolerando los tipos que produce YAML/Go (int, int64, float64). Devuelve def
// si la clave no existe o no es numerica.
func configFloat(cfg map[string]interface{}, key string, def float64) float64 {
	v, ok := cfg[key]
	if !ok {
		return def
	}
	switch val := v.(type) {
	case float64:
		return val
	case int:
		return float64(val)
	case int64:
		return float64(val)
	default:
		return def
	}
}

// configInt es el equivalente entero de configFloat.
func configInt(cfg map[string]interface{}, key string, def int) int {
	v, ok := cfg[key]
	if !ok {
		return def
	}
	switch val := v.(type) {
	case int:
		return val
	case int64:
		return int(val)
	case float64:
		return int(val)
	default:
		return def
	}
}
