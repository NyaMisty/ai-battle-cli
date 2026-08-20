export class BattleError extends Error {
  constructor(message: string, public statusCode: number, public errorKey?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends BattleError {
  constructor(key = "roomNotFound") { super(key, 404, key); }
}

export class ForbiddenError extends BattleError {
  constructor(key = "forbidden") { super(key, 403, key); }
}

export class ConflictError extends BattleError {
  constructor(key = "conflict") { super(key, 409, key); }
}

export class BadRequestError extends BattleError {
  constructor(key = "badRequest") { super(key, 400, key); }
}
