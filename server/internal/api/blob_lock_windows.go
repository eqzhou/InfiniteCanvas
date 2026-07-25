//go:build windows

package api

func lockTenantBlob(_, _, _ string) (func(), error) {
	return func() {}, nil
}
