module github.com/lokiteitor/market-simulator/bots-v1

go 1.22.2

replace github.com/lokiteitor/market-simulator => ../go-sdk

require (
	github.com/lokiteitor/market-simulator v0.0.0-20260709231009-91e31f3c0e0e
	gopkg.in/yaml.v3 v3.0.1
)

require github.com/gorilla/websocket v1.5.3 // indirect
