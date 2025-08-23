import { resetCredentials } from "./browser";


process.on("unhandledRejection",console.error);
process.on("uncaughtException",console.error);

resetCredentials().then(console.log).catch(console.error)