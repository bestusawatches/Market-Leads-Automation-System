declare module 'https-proxy-agent' {
  import { Agent } from 'http';
  interface HttpsProxyAgentOptions {
    [key: string]: any;
  }
  export default class HttpsProxyAgent extends Agent {
    constructor(opts?: string | HttpsProxyAgentOptions);
  }
  export { HttpsProxyAgent };
}
