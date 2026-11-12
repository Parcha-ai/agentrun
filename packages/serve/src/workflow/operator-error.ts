/** An error whose message is written for the operator, so the extension shows it as it is. Any other error reaches the
 *  operator as a generic message, since its text may carry what an operator should not see. Its name stays `Error`. */
export class OperatorError extends Error {}
