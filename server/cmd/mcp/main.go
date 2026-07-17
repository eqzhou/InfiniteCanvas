package main

import (
	"context"
	"fmt"
	"os"

	"github.com/openboard/openboard/server/internal/api"
	"github.com/openboard/openboard/server/internal/appdir"
	"github.com/openboard/openboard/server/internal/mcpserver"
)

func main() {
	dataDir := os.Getenv("OPENBOARD_DATA")
	if dataDir == "" {
		dataDir = appdir.DefaultDataDir()
	}
	if err := api.SecureDataDir(dataDir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	server := mcpserver.New(dataDir)
	if connectionFile := os.Getenv("OPENBOARD_CONNECTION_FILE"); connectionFile != "" {
		remote, err := mcpserver.NewRemote(connectionFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		server = remote
	}
	if err := server.Run(context.Background(), os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
