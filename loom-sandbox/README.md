# loom-sandbox

Mini Node project used by Loom R1 to prove Workers touch **real files**.

Intentional bug: `divide(a, 0)` does not throw (returns `Infinity`).

After Loom Feishu bug-fix path: Worker patches `src/calc.js` so divide-by-zero throws.
