import { divide } from './calc.js';
const a = Number(process.argv[2] ?? 10);
const b = Number(process.argv[3] ?? 0);
console.log(divide(a, b));
