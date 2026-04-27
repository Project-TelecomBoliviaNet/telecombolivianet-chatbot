import { createHmac, timingSafeEqual } from 'crypto';

// ══════════════════════════════════════════════════════════════
// TIMING-SAFE TOKEN COMPARISON
//
// La comparación directa de strings (===) es vulnerable a
// timing attacks: un atacante puede medir el tiempo de respuesta
// para adivinar carácter a carácter el token secreto.
//
// timingSafeEqual() de Node.js crypto compara en tiempo
// constante independientemente de dónde difieren los buffers.
//
// Uso:
//   if (!isValidToken(receivedToken, expectedToken)) throw new UnauthorizedException();
// ══════════════════════════════════════════════════════════════

/**
 * Compara dos strings de forma segura contra timing attacks.
 * Siempre tarda el mismo tiempo independientemente de la diferencia.
 */
export function isValidToken(received: string, expected: string): boolean {
  if (!received || !expected) return false;

  // timingSafeEqual requiere buffers de igual longitud.
  // Usamos HMAC con una clave fija para normalizar la longitud
  // sin revelar información sobre el token esperado.
  const key = Buffer.alloc(32);  // clave fija de 32 bytes cero (solo para normalizar longitud)
  const a = createHmac('sha256', key).update(received).digest();
  const b = createHmac('sha256', key).update(expected).digest();

  return timingSafeEqual(a, b);
}

/**
 * Extrae el token Bearer de un header Authorization.
 * Devuelve null si el formato no es válido.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}
