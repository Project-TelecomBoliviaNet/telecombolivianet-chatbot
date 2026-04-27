/**
 * @file pseudonym-expired.error.ts
 * @description Error lanzado cuando la tabla de correspondencia expiró en Redis.
 *
 * Permite al caller distinguir este caso específico y responder
 * al usuario con un mensaje apropiado en lugar de un error 500.
 */

export class PseudonymExpiredError extends Error {
  readonly mappingKey: string;

  constructor(mappingKey: string) {
    super(
      `La tabla de seudonimización expiró o no existe. ` +
      `Clave Redis: ${mappingKey}. ` +
      `El usuario debe reiniciar la consulta.`,
    );
    this.name       = 'PseudonymExpiredError';
    this.mappingKey = mappingKey;

    // Necesario para que instanceof funcione correctamente con herencia en TS
    Object.setPrototypeOf(this, PseudonymExpiredError.prototype);
  }
}
