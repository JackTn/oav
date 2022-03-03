import * as fs from "fs";
import * as path from "path";
import { resolve as pathResolve } from "path";
import { glob } from "glob";
import { toLower } from "lodash";
import {
  LiveValidationIssue,
  LiveValidator,
  RequestResponsePair,
} from "../liveValidation/liveValidator";
import { DefaultConfig } from "../util/constants";
import { apiValidationErrors, ErrorCodeConstants } from "../util/errorDefinitions";
import { OperationContext } from "../liveValidation/operationValidator";
import { Options } from "../validate";
import { traverseSwagger } from "../transform/traverseSwagger";
import { Operation, Path, LowerHttpMethods } from "../swagger/swaggerTypes";
import { LiveValidatorLoader } from "../liveValidation/liveValidatorLoader";
import { inversifyGetContainer, inversifyGetInstance } from "../inversifyUtils";

export interface TrafficValidationOptions extends Options {
  sdkPackage?: string;
  sdkLanguage?: string;
  reportPath?: string;
}
export interface TrafficValidationIssue {
  payloadFilePath?: string;
  specFilePath?: string;
  errors?: LiveValidationIssue[];
  operationInfo?: OperationContext;
  runtimeExceptions?: RuntimeException[];
}

export interface RuntimeException {
  code: string;
  message: string;
}

export interface OperationCoverageInfo {
  readonly spec: string;
  readonly coveredOperaions: number;
  readonly validationFailOperations: number;
  readonly totalOperations: number;
  readonly coverageRate: number;
}

export class TrafficValidator {
  private liveValidator: LiveValidator;
  private trafficValidationResult: TrafficValidationIssue[] = [];
  private trafficFiles: string[] = [];
  private specPath: string;
  private trafficPath: string;
  private loader?: LiveValidatorLoader;
  private trafficOperation: Map<string, string[]> = new Map<string, string[]>();
  private validationFailOperations: Map<string, string[]> = new Map<string, string[]>();
  private coverageData: Map<string, number> = new Map<string, number>();
  public operationSpecMapper: Map<string, string[]> = new Map<string, string[]>();
  public operationCoverageResult: OperationCoverageInfo[] = [];
  public operationUndefinedResult: number = 0;

  public constructor(specPath: string, trafficPath: string) {
    this.specPath = specPath;
    this.trafficPath = trafficPath;
  }

  public async initialize() {
    const specPathStats = fs.statSync(this.specPath);
    const trafficPathStats = fs.statSync(this.trafficPath);
    let specFileDirectory = "";
    let swaggerPathsPattern = "**/*.json";
    if (specPathStats.isFile()) {
      specFileDirectory = path.dirname(this.specPath);
      swaggerPathsPattern = path.basename(this.specPath);
    } else if (specPathStats.isDirectory()) {
      specFileDirectory = this.specPath;
    }
    if (trafficPathStats.isFile()) {
      this.trafficFiles.push(this.trafficPath);
    } else if (trafficPathStats.isDirectory()) {
      const searchPattern = path.join(this.trafficPath, "**/*.json");
      const matchedPaths = glob.sync(searchPattern, {
        nodir: true,
      });
      for (const filePath of matchedPaths) {
        this.trafficFiles.push(filePath);
      }
    }

    const liveValidationOptions = {
      checkUnderFileRoot: false,
      loadValidatorInBackground: false,
      directory: specFileDirectory,
      swaggerPathsPattern: [swaggerPathsPattern],
      excludedSwaggerPathsPattern: DefaultConfig.ExcludedExamplesAndCommonFiles,
      git: {
        shouldClone: false,
      },
    };

    this.liveValidator = new LiveValidator(liveValidationOptions);
    await this.liveValidator.initialize();

    const container = inversifyGetContainer();
    this.loader = inversifyGetInstance(LiveValidatorLoader, {
      container,
      fileRoot: liveValidationOptions.directory,
      ...liveValidationOptions,
      loadSuppression: Object.keys(apiValidationErrors),
    });

    const swaggerPaths = this.liveValidator.swaggerList;
    while (swaggerPaths.length > 0) {
      let swaggerPath = swaggerPaths.shift()!;
      let spec;
      try {
        spec = await this.loader.load(pathResolve(swaggerPath));
      } catch (e) {
        console.log(
          `Exception when loading spec, ErrorMessage: ${e?.message}; ErrorStack: ${e?.stack}.`
        );
      }
      if (spec !== undefined) {
        swaggerPath = toLower(swaggerPath);
        // Get Swagger - operation mapper.
        if (this.operationSpecMapper.get(swaggerPath) === undefined) {
          this.operationSpecMapper.set(swaggerPath, []);
        }
        traverseSwagger(spec, {
          onOperation: (operation: Operation, _path: Path, _method: LowerHttpMethods) => {
            if (
              operation.operationId !== undefined &&
              !this.operationSpecMapper.get(swaggerPath)?.includes(operation.operationId)
            ) {
              this.operationSpecMapper.get(swaggerPath)!.push(operation.operationId);
            }
          },
        });
      }
    }
  }

  public async validate(): Promise<TrafficValidationIssue[]> {
    let payloadFilePath;
    try {
      for (const trafficFile of this.trafficFiles) {
        payloadFilePath = trafficFile;
        const payload: RequestResponsePair = require(trafficFile);
        const validationResult = await this.liveValidator.validateLiveRequestResponse(payload);
        const operationInfo = validationResult.requestValidationResult?.operationInfo;
        const liveRequest = payload.liveRequest;
        const correlationId = liveRequest.headers?.["x-ms-correlation-request-id"] || "";
        const opInfo = await this.liveValidator.getOperationInfo(liveRequest, correlationId);
        let swaggerFile;
        if (liveRequest.url.includes("provider")) {
          // This is for validation of resource-manager
          swaggerFile = this.findSwaggerByOperationInfo(opInfo.info);
        } else {
          // This is for validation of data-plane
          swaggerFile = this.findSwaggerByOperationId(opInfo.info);
        }
        if (swaggerFile !== undefined) {
          if (this.trafficOperation.get(swaggerFile) === undefined) {
            this.trafficOperation.set(swaggerFile, []);
          }
          if (!this.trafficOperation.get(swaggerFile)?.includes(opInfo.info.operationId)) {
            this.trafficOperation.get(swaggerFile)?.push(opInfo.info.operationId);
          }
          if (
            validationResult.requestValidationResult.isSuccessful === false ||
            validationResult.requestValidationResult.isSuccessful === undefined ||
            validationResult.responseValidationResult.isSuccessful === false ||
            validationResult.responseValidationResult.isSuccessful === undefined ||
            validationResult.runtimeException !== undefined
          ) {
            if (this.validationFailOperations.get(swaggerFile) === undefined) {
              this.validationFailOperations.set(swaggerFile, []);
            }
            if (
              !this.validationFailOperations.get(swaggerFile)?.includes(opInfo.info.operationId)
            ) {
              this.validationFailOperations.get(swaggerFile)?.push(opInfo.info.operationId);
            }
          }
        } else {
          console.log(`Error: Undefined operation ${JSON.stringify(opInfo.info)}`);
          this.operationUndefinedResult = this.operationUndefinedResult + 1;
        }

        const errorResult: LiveValidationIssue[] = [];
        const runtimeExceptions: RuntimeException[] = [];
        if (validationResult.requestValidationResult.isSuccessful === undefined) {
          runtimeExceptions.push(validationResult.requestValidationResult.runtimeException!);
        } else if (validationResult.requestValidationResult.isSuccessful === false) {
          errorResult.push(...validationResult.requestValidationResult.errors);
        }

        if (validationResult.responseValidationResult.isSuccessful === undefined) {
          runtimeExceptions.push(validationResult.responseValidationResult.runtimeException!);
        } else if (validationResult.responseValidationResult.isSuccessful === false) {
          errorResult.push(...validationResult.responseValidationResult.errors);
        }
        if (errorResult.length > 0 || runtimeExceptions.length > 0) {
          this.trafficValidationResult.push({
            payloadFilePath,
            errors: errorResult,
            runtimeExceptions,
            operationInfo: operationInfo,
          });
        }
      }
    } catch (err) {
      const msg = `Detail error message:${err?.message}. ErrorStack:${err?.Stack}`;
      this.trafficValidationResult.push({
        payloadFilePath,
        runtimeExceptions: [
          {
            code: ErrorCodeConstants.RUNTIME_ERROR,
            message: msg,
          },
        ],
      });
    }
    let coveredOperaions: number;
    let coverageRate: number;
    let validationFailOperations: number;
    this.operationSpecMapper.forEach((value: string[], key: string) => {
      if (this.trafficOperation.get(key) === undefined) {
        coveredOperaions = 0;
        coverageRate = 0;
        this.coverageData.set(key, 0);
      } else if (value !== undefined && value.length !== 0) {
        coveredOperaions = this.trafficOperation.get(key)!.length;
        coverageRate = coveredOperaions / value.length;
        this.coverageData.set(key, coverageRate);
      } else {
        coveredOperaions = 0;
        coverageRate = 0;
        this.coverageData.set(key, 0);
      }

      if (this.validationFailOperations.get(key) === undefined) {
        validationFailOperations = 0;
      } else {
        validationFailOperations = this.validationFailOperations.get(key)!.length;
      }
      this.operationCoverageResult.push({
        spec: key,
        coveredOperaions: coveredOperaions,
        coverageRate: coverageRate,
        totalOperations: value.length,
        validationFailOperations: validationFailOperations,
      });
    });
    return this.trafficValidationResult;
  }

  private findSwaggerByOperationInfo(operationInfo: OperationContext) {
    let result = undefined;
    if (operationInfo.validationRequest === undefined) {
      return result;
    }
    for (const key of this.operationSpecMapper.keys()) {
      const value = this.operationSpecMapper.get(key);
      if (
        key.includes(toLower(operationInfo.apiVersion)) &&
        key.includes(toLower(operationInfo.validationRequest?.providerNamespace))
      ) {
        if (value!.includes(operationInfo.operationId)) {
          result = key;
          return result;
        }
      }
    }
    return result;
  }

  private findSwaggerByOperationId(operationInfo: OperationContext) {
    let result = undefined;
    for (const key of this.operationSpecMapper.keys()) {
      const value = this.operationSpecMapper.get(key);
      if (
        key.includes(toLower(operationInfo.apiVersion)) &&
        value!.includes(operationInfo.operationId)
      ) {
        result = key;
        return result;
      }
    }
    return result;
  }
}
