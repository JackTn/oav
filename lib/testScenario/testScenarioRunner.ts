import { HttpMethods } from "@azure/core-http";
import { getDefaultAzureCredential } from "@azure/identity";
import { JsonLoader } from "../swagger/jsonLoader";
import { setDefaultOpts } from "../swagger/loader";
import { getLazyBuilder } from "../util/lazyBuilder";
import {
  ArmTemplate,
  TestDefinitionFile,
  TestScenario,
  TestStep,
  TestStepArmTemplateDeployment,
  TestStepExampleFileRestCall,
} from "./testResourceTypes";
import { TestScenarioRestClient } from "./testScenarioRestClient";
import { VariableEnv } from "./variableEnv";

export interface TestScenarioRunnerOption {
  env?: VariableEnv;
  client?: TestScenarioRunnerClient;
  jsonLoader: JsonLoader;
}

export type ArmDeploymentTracking = {
  deploymentName: string;
  step: TestStepArmTemplateDeployment;
  details: {
    scope: "ResourceGroup";
    subscriptionId: string;
    resourceGroupName: string;
  };
};

interface TestScopeTracking {
  provisioned?: boolean;
  scope: TestDefinitionFile["scope"];
  prepareSteps: TestStep[];
  env: VariableEnv;
  armDeployments: ArmDeploymentTracking[];
}

export type TestStepEnv = {
  env: VariableEnv;
  scope: TestDefinitionFile["scope"];
  armDeployments: ArmDeploymentTracking[];
};

export interface TestScenarioClientRequest {
  method: HttpMethods;
  path: string;
  headers: { [headerName: string]: string };
  query: { [headerName: string]: string };
  body: any;
}

export interface TestScenarioRunnerClient {
  createResourceGruop(
    subscriptionId: string,
    resourceGroupName: string,
    location: string
  ): Promise<void>;

  sendExampleRequest(
    request: TestScenarioClientRequest,
    step: TestStepExampleFileRestCall,
    stepEnv: TestStepEnv
  ): Promise<void>;

  sendArmTemplateDeployment(
    armTemplate: ArmTemplate,
    params: { [name: string]: string },
    armDeployment: ArmDeploymentTracking,
    step: TestStepArmTemplateDeployment,
    stepEnv: TestStepEnv
  ): Promise<void>;
}

const numbers = "0123456789";
const lowerCases = "abcedfghijklmnopqrskuvwxyz";
const upperCases = "ABCEDFGHIJKLMNOPQRSKUVWXYZ";
export const getRandomString = (
  config: {
    length?: number;
    lowerCase?: boolean;
    upperCase?: boolean;
    number?: boolean;
  } = {}
) => {
  setDefaultOpts(config, {
    length: 6,
    lowerCase: true,
    upperCase: false,
    number: false,
  });

  const allowedChars = `${config.number ? numbers : ""}${config.lowerCase ? lowerCases : ""}${
    config.upperCase ? upperCases : ""
  }`;
  let result = "";
  for (let idx = 0; idx < config.length!; idx++) {
    result = result + allowedChars[Math.floor(Math.random() * allowedChars.length)];
  }
  return result;
};

export class TestScenarioRunner {
  private jsonLoader: JsonLoader;
  private client: TestScenarioRunnerClient;
  private env: VariableEnv;
  private testScopeTracking: { [scopeName: string]: TestScopeTracking };

  private provisionTestScope = getLazyBuilder(
    "provisioned",
    async (testScope: TestScopeTracking) => {
      if (testScope.scope !== "ResourceGroup") {
        throw new Error(`TestScope is not supported yet: ${testScope.scope}`);
      }

      const subscriptionId = testScope.env.getRequired("subscriptionId");
      const location = testScope.env.getRequired("location");
      const resourceGroupPrefix = testScope.env.get("resourceGroupPrefix") ?? "test-";
      const resourceGroupName =
        resourceGroupPrefix +
        getRandomString({ length: 6, lowerCase: true, upperCase: true, number: true });
      testScope.env.setBatch({ resourceGroupName });

      await this.client.createResourceGruop(subscriptionId, resourceGroupName, location);

      for (const step of testScope.prepareSteps) {
        await this.executeStep(step, testScope.env, testScope);
      }

      return true;
    }
  );

  constructor(opts: TestScenarioRunnerOption) {
    this.env = opts.env ?? new VariableEnv();
    this.client = opts.client ?? new TestScenarioRestClient(getDefaultAzureCredential(), {});
    this.jsonLoader = opts.jsonLoader;
    this.testScopeTracking = {};
  }

  public async prepareScenario(testScenario: TestScenario): Promise<TestScopeTracking> {
    const s = testScenario.shareTestScope;
    const testScopeName =
      typeof s === "string" ? s : s ? "_defaultScope" : `_randomScope_${getRandomString()}`;

    let testScope = this.testScopeTracking[testScopeName];
    if (testScope === undefined) {
      const testDef = testScenario._testDef;
      const env = new VariableEnv(this.env);
      testScope = {
        scope: testDef.scope,
        prepareSteps: testDef.prepareSteps,
        env,
        armDeployments: [],
      };
      this.testScopeTracking[testScopeName] = testScope;
    }

    await this.provisionTestScope(testScope);
    return testScope;
  }

  public async executeScenario(testScenario: TestScenario) {
    const testScope = await this.prepareScenario(testScenario);
    const env = new VariableEnv(testScope.env);

    for (const step of testScenario.steps) {
      await this.executeStep(step, env, testScope);
    }
  }

  public async executeStep(step: TestStep, env: VariableEnv, testScope: TestScopeTracking) {
    const stepEnv = new VariableEnv(env);
    stepEnv.setBatch(step.variables);
    stepEnv.setWriteEnv(env);

    switch (step.type) {
      case "exampleFile":
        await this.executeExampleFileStep(step, env, testScope);
        break;

      case "armTemplateDeployment":
        await this.executeArmTemplateStep(step, env, testScope);
        break;
    }
  }

  private async executeExampleFileStep(
    step: TestStepExampleFileRestCall,
    env: VariableEnv,
    testScope: TestScopeTracking
  ) {
    const operation = step.operation;

    const pathEnv = new VariableEnv();
    let req: TestScenarioClientRequest = {
      method: step.operation._method.toUpperCase() as HttpMethods,
      path: "",
      headers: {},
      query: {},
      body: {},
    };

    for (const p of operation.parameters ?? []) {
      const param = this.jsonLoader.resolveRefObj(p);
      const paramValue = step.exampleTemplate.parameters[param.name];
      if (paramValue === undefined) {
        throw new Error(
          `Parameter value for "${param.name}" is not found in example: ${step.exampleFilePath}`
        );
      }

      switch (param.in) {
        case "path":
          pathEnv.set(param.name, paramValue);
          break;
        case "query":
          req.query[param.name] = paramValue;
          break;
        case "header":
          req.headers[param.name] = paramValue;
          break;
        case "body":
          req.body = paramValue;
          break;
        default:
          throw new Error(`Parameter "in" not supported: ${param.in}`);
      }
    }
    req.path = pathEnv.resolveString(operation._path._pathTemplate, "{", "}");
    req = env.resolveObjectValues(req);
    console.log(req);

    await this.client.sendExampleRequest(req, step, {
      env,
      scope: testScope.scope,
      armDeployments: testScope.armDeployments,
    });
  }

  private async executeArmTemplateStep(
    step: TestStepArmTemplateDeployment,
    env: VariableEnv,
    testScope: TestScopeTracking
  ) {
    const params: { [key: string]: string } = {};
    const paramsDef = step.armTemplatePayload.parameters ?? {};
    for (const paramName of Object.keys(paramsDef)) {
      const paramDef = paramsDef[paramName];
      if (paramDef.type !== "string") {
        continue;
      }

      let paramValue = env.get(paramName);
      if (paramValue === undefined) {
        continue;
      }

      paramValue = env.resolveString(paramValue);
      params[paramName] = paramValue;
    }

    const subscriptionId = env.getRequired("subscriptionId");
    const resourceGroupName = env.getRequired("resourceGroupName");

    const armDeployment: ArmDeploymentTracking = {
      deploymentName: `${resourceGroupName}-deploy-${getRandomString()}`,
      step,
      details: {
        scope: testScope.scope,
        subscriptionId,
        resourceGroupName,
      },
    };
    testScope.armDeployments.push(armDeployment);

    await this.client.sendArmTemplateDeployment(
      step.armTemplatePayload,
      params,
      armDeployment,
      step,
      {
        env,
        scope: testScope.scope,
        armDeployments: testScope.armDeployments,
      }
    );
  }
}
