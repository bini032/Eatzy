// message는 한국어 문장(번역 키, src/i18n.js), params는 {이름} 자리에 들어갈 값
class AppError extends Error {
  constructor(status, message, code, params) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params || {};
  }
}

module.exports = { AppError };
