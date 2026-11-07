/** 统一错误类型：所有「账本/迁移/产物」层面的错误都用它，便于引擎一处捕获 */
export class StateError extends Error {
  code: string;
  constructor(message: string, code = 'STATE') {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

/** 工具/命令层错误（git、测试命令、外部 CLI） */
export class ToolError extends Error {
  code: string;
  detail: string;
  constructor(message: string, detail = '', code = 'TOOL') {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.detail = detail;
  }
}

/** 模型层错误（超时、返回不可解析） */
export class ModelError extends Error {
  code: string;
  constructor(message: string, code = 'MODEL') {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}
