/// <reference types="vite/client" />

// 只为了让 `import.meta.glob` / `import.meta.env` 有类型；
// 渲染层没有 node 侧环境变量访问权限，不要在这里 `/// <reference types="node" />`。
