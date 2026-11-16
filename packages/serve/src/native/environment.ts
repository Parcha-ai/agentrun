import { handedSecret, SECRET_NAMES } from '../secrets.js';

/** Source-machine execution inherits the operator's original native environment, including startup credentials that
 * serve's launcher holds off process.env. Settings keys and AgentRun's own credentials are never injected. Managed
 * adapters continue to receive their isolated per-run environment. */
export function nativeEnvironment():NodeJS.ProcessEnv{
 const env={...process.env};
 for(const name of SECRET_NAMES){
  if(name.startsWith('AGENTRUN_'))continue;
  const value=handedSecret(name);if(value!==undefined)env[name]=value;
 }
 for(const name of Object.keys(env))if(name.startsWith('AGENTRUN_'))delete env[name];
 return env;
}
