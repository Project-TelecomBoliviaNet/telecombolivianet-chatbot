import { isValidToken, extractBearerToken } from './token.util';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — token.util.ts
// Cubre: isValidToken(), extractBearerToken().
// Sin dependencias externas — lógica pura de Node.js crypto.
// ══════════════════════════════════════════════════════════════

describe('isValidToken()', () => {
  const SECRET = 'mi-token-super-secreto-de-32-chars';

  it('retorna true para tokens idénticos', () => {
    expect(isValidToken(SECRET, SECRET)).toBe(true);
  });

  it('retorna false para tokens distintos', () => {
    expect(isValidToken('token-incorrecto', SECRET)).toBe(false);
  });

  it('retorna false si received está vacío', () => {
    expect(isValidToken('', SECRET)).toBe(false);
  });

  it('retorna false si expected está vacío', () => {
    expect(isValidToken(SECRET, '')).toBe(false);
  });

  it('retorna false para ambos vacíos', () => {
    expect(isValidToken('', '')).toBe(false);
  });

  it('es case-sensitive', () => {
    expect(isValidToken(SECRET.toUpperCase(), SECRET)).toBe(false);
  });

  it('detecta diferencia de un solo carácter', () => {
    const tokenConDiferencia = SECRET.slice(0, -1) + 'X';
    expect(isValidToken(tokenConDiferencia, SECRET)).toBe(false);
  });

  it('maneja tokens con caracteres especiales', () => {
    const token = 'abc!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
    expect(isValidToken(token, token)).toBe(true);
    expect(isValidToken(token + 'x', token)).toBe(false);
  });

  it('maneja tokens de diferente longitud sin crashing', () => {
    expect(isValidToken('corto', 'token-mucho-mas-largo-que-el-anterior')).toBe(false);
    expect(isValidToken('token-mucho-mas-largo-que-el-anterior', 'corto')).toBe(false);
  });
});

describe('extractBearerToken()', () => {
  it('extrae el token de un header Bearer válido', () => {
    expect(extractBearerToken('Bearer mi-token-secreto')).toBe('mi-token-secreto');
  });

  it('retorna null para header undefined', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('retorna null para string vacío', () => {
    expect(extractBearerToken('')).toBeNull();
  });

  it('retorna null si no empieza con "Bearer "', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('Token abc123')).toBeNull();
    expect(extractBearerToken('bearer token-minuscula')).toBeNull();
  });

  it('retorna null si el token está vacío después de "Bearer "', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
    expect(extractBearerToken('Bearer    ')).toBeNull();
  });

  it('preserva el token exactamente (no lo modifica)', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.abc.xyz';
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
  });

  it('elimina espacios sobrantes alrededor del token', () => {
    expect(extractBearerToken('Bearer   token-con-espacios   ')).toBe('token-con-espacios');
  });
});
