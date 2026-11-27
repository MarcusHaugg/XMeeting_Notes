// Erro com status HTTP e mensagem que pode ser mostrada ao usuário do app.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
