import { IDebugger } from 'debug';
import * as _ from 'lodash';
import { EOL } from 'os';
import * as readable from 'readable-stream';
import { YESNO_RECORDING_MODE_ENV_VAR } from './consts';
import Context, { IInFlightRequest } from './context';
import { YesNoError } from './errors';
import * as file from './file';
import FilteredHttpCollection, { IFiltered } from './filtering/collection';
import * as comparator from './filtering/comparator';
import { ISerializedHttpPartialDeepMatch, MatchFn } from './filtering/matcher';
import { Redactor } from './filtering/redact';
import {
  createRecord,
  formatUrl,
  ISerializedHttp,
  ISerializedRequest,
  ISerializedResponse,
  validateSerializedHttpArray,
} from './http-serializer';
import Interceptor, { IInterceptEvent, IInterceptOptions, IProxiedEvent } from './interceptor';
import Recording, { RecordMode as Mode } from './recording';
const debug: IDebugger = require('debug')('yesno');

export type GenericTest = (...args: any) => Promise<any> | void;
export type GenericTestFunction = (title: string, fn: GenericTest) => any;

export type HttpFilter = string | RegExp | ISerializedHttpPartialDeepMatch | MatchFn;

export interface IRecordableTest {
  test?: GenericTestFunction;
  it?: GenericTestFunction;
  prefix?: string;
  dir: string;
}

export class YesNo implements IFiltered {
  private mode: Mode = Mode.Spy;
  private readonly interceptor: Interceptor;
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.interceptor = this.createInterceptor();
  }

  /**
   * Restore HTTP functionality
   */
  public restore(): void {
    debug('Disabling intercept');
    this.clear();
    this.interceptor.disable();
  }

  /**
   * Spy on intercepted requests
   */
  public spy(options?: IInterceptOptions): void {
    this.enable(options);
    this.setMode(Mode.Spy);
  }

  /**
   * Mock responses for intercepted requests
   * @todo Reset the request counter?
   */
  public mock(mocks: file.IHttpMock[], options?: IInterceptOptions): void {
    this.enable(options);
    this.setMode(Mode.Mock);

    this.setMocks(mocks.map(file.hydrateHttpMock));
  }

  public recording(options: file.IFileOptions): Promise<Recording> {
    const mode = this.getModeByEnv();

    return new Promise((resolve, reject) => {
      if (mode !== Mode.Mock) {
        this.spy();
        resolve();
      } else {
        this.load(options)
          .then((mock) => {
            this.mock(mock);
            resolve();
          })
          .catch(reject);
      }
    }).then(
      () =>
        new Recording({
          ...options,
          getRecordsToSave: this.getRecordsToSave.bind(this),
          mode,
        }),
    );
  }

  /**
   * Create a test function that will wrap its provided test in a recording.
   */
  public test({ it, test, dir, prefix }: IRecordableTest): GenericTestFunction {
    const runTest = test || it;

    if (!runTest) {
      throw new YesNoError('Missing "test" or "it" test function');
    }

    return (title: string, fn: GenericTest): GenericTestFunction => {
      const filename = file.getMockFilename(prefix ? `${prefix}-${title}` : title, dir);

      return runTest(title, () => {
        debug('Running test "%s"', title);
        this.restore();

        return this.recording({ filename })
          .then((recording) => {
            return new Promise((resolve, reject) => {
              // invoke their function
              const results = fn();

              // conditionally follow a promise, if it is returned
              if (results && results.then) {
                results.then(resolve).catch(reject);
              } else {
                resolve();
              }
            }).then(() => {
              debug('Saving test "%s"', filename);
              return recording.complete();
            });
          })
          .then(() => {
            this.restore();
          })
          .catch((error) => {
            this.restore();
            throw error;
          });
      });
    };
  }

  /**
   * Load request/response mocks from disk
   */
  public load(options: file.IFileOptions): Promise<ISerializedHttp[]> {
    debug('Loading mocks');

    return file.load(options as file.IFileOptions).then((records) => {
      validateSerializedHttpArray(records);
      return records;
    });
  }
  /**
   * Save intercepted requests
   *
   * @returns Full filename of saved JSON if generated
   */
  public save(options: file.ISaveOptions & file.IFileOptions): Promise<string | void> {
    options.records = options.records || this.getRecordsToSave();

    return file.save(options);
  }

  /**
   * Clear all stateful information about requests.
   *
   * If used in a test suite, this should be called after each test.
   */
  public clear() {
    this.ctx.clear();
    (this.interceptor as Interceptor).requestNumber = 0;
  }

  /**
   * Create a filter collection
   * @todo Convert everything to a match fn
   * @param query
   */
  public matching(filter?: HttpFilter): FilteredHttpCollection {
    const normalizedFilter: ISerializedHttpPartialDeepMatch | MatchFn | undefined =
      _.isString(filter) || _.isRegExp(filter) ? { url: filter } : filter;

    return this.getCollection(normalizedFilter);
  }

  /**
   * Get all intercepted requests
   */
  public intercepted(): ISerializedHttp[] {
    return this.getCollection().intercepted();
  }

  /**
   * Get all loaded mocks
   */
  public mocks(): ISerializedHttp[] {
    return this.getCollection().mocks();
  }

  /**
   * Redact property on all records
   */
  public redact(property: string | string[], redactor?: Redactor): void {
    return this.getCollection().redact(property, redactor);
  }

  private getModeByEnv(): Mode {
    const env = (process.env[YESNO_RECORDING_MODE_ENV_VAR] || Mode.Mock).toLowerCase();

    if (!Object.values(Mode).includes(env)) {
      throw new YesNoError(
        // tslint:disable-next-line:max-line-length
        `Invalid mode "${env}" set for ${YESNO_RECORDING_MODE_ENV_VAR}. Must be one of ${Object.values(
          Mode,
        ).join(', ')}`,
      );
    }

    return env as Mode;
  }

  private getRecordsToSave(): ISerializedHttp[] {
    const inFlightRequests = this.ctx.inFlightRequests.filter((x) => x) as IInFlightRequest[];

    if (inFlightRequests.length) {
      const urls = inFlightRequests
        .map(
          ({ requestSerializer }) => `${requestSerializer.method}${formatUrl(requestSerializer)}`,
        )
        .join(EOL);
      throw new YesNoError(
        `Cannot save. Still have ${inFlightRequests.length} in flight requests: ${EOL}${urls}`,
      );
    }

    return this.ctx.interceptedRequestsCompleted;
  }

  /**
   * Enable intercepting requests
   */
  private enable(options?: IInterceptOptions): YesNo {
    const { comparatorFn, ignorePorts = [] }: IInterceptOptions = options || {};

    debug('Enabling intercept. Ignoring ports', ignorePorts);
    this.interceptor.enable({ comparatorFn, ignorePorts });

    return this;
  }

  private setMocks(mocks: ISerializedHttp[]): void {
    validateSerializedHttpArray(mocks);
    this.ctx.loadedMocks = mocks;
  }

  /**
   * Determine the current mode
   */
  private isMode(mode: Mode): boolean {
    return this.mode === mode;
  }

  private createInterceptor() {
    const interceptor = new Interceptor({ shouldProxy: !this.isMode(Mode.Mock) });
    interceptor.on('intercept', (event: IInterceptEvent) => {
      this.ctx.inFlightRequests[event.requestNumber] = {
        requestSerializer: event.requestSerializer,
        startTime: Date.now(),
      };

      if (this.isMode(Mode.Mock)) {
        this.mockResponse(event);
      }
    });

    interceptor.on(
      'proxied',
      ({ requestSerializer, responseSerializer, requestNumber }: IProxiedEvent) => {
        this.recordCompleted(
          requestSerializer.serialize(),
          responseSerializer.serialize(),
          requestNumber,
        );
      },
    );

    return interceptor;
  }

  private setMode(mode: Mode) {
    this.mode = mode;

    if (this.interceptor) {
      this.interceptor.proxy(!this.isMode(Mode.Mock));
    }
  }

  private getCollection(
    matcher?: ISerializedHttpPartialDeepMatch | MatchFn,
  ): FilteredHttpCollection {
    return new FilteredHttpCollection({
      context: this.ctx,
      matcher,
    });
  }

  private mockResponse({
    clientRequest,
    comparatorFn,
    interceptedRequest,
    interceptedResponse,
    requestSerializer,
    requestNumber,
  }: IInterceptEvent): Promise<void> {
    debug('Mock response');

    return new Promise((resolve, reject) => {
      (readable as any).pipeline(interceptedRequest, requestSerializer, (error: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    })
      .then(() => {
        const serializedRequest = requestSerializer.serialize();
        const mock = this.ctx.loadedMocks[requestNumber];

        if (!mock) {
          throw new YesNoError(`No mock found for request #${requestNumber}`);
        }

        // Assertion must happen before promise -
        // mitm does not support promise rejections on "request" event
        try {
          // determine how we'll compare the request and the mock
          const compareBy: comparator.ComparatorFn = comparatorFn || comparator.byUrl;

          // the comparison function must throw an error to signal a mismatch
          compareBy(serializedRequest, mock.request, { requestIndex: requestNumber });
        } catch (err) {
          // ensure any user-thrown error is wrapped in our YesNoError
          throw new YesNoError(err.message);
        }

        const bodyString = _.isPlainObject(mock.response.body)
          ? JSON.stringify(mock.response.body)
          : mock.response.body;
        interceptedResponse.writeHead(mock.response.statusCode, mock.response.headers);
        interceptedResponse.write(bodyString);
        interceptedResponse.end();

        this.recordCompleted(serializedRequest, mock.response, requestNumber);
      })
      .catch((e: Error) => {
        if (!(e instanceof YesNoError)) {
          debug('Mock response failed unexpectedly', e);
          e.message = `YesNo: Mock response failed: ${e.message}`;
        } else {
          debug('Mock response failed', e.message);
        }

        clientRequest.emit('error', e);
      });
  }

  private recordCompleted(
    request: ISerializedRequest,
    response: ISerializedResponse,
    requestNumber: number,
  ): void {
    const duration =
      Date.now() - (this.ctx.inFlightRequests[requestNumber] as IInFlightRequest).startTime;
    const record = createRecord({ request, response, duration });
    this.ctx.interceptedRequestsCompleted[requestNumber] = record;
    this.ctx.inFlightRequests[requestNumber] = null;

    debug(
      'Added request-response for %s %s (duration: %d)',
      request.method,
      record.request.host,
      duration,
    );
  }
}
