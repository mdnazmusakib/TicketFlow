/**
 * Jest runs CommonJS; some ESM-only dependencies (react-router) reference
 * `import.meta.hot` for Vite HMR. Replace every `import.meta` with an empty
 * object so the code compiles to CommonJS. Test-only.
 */
module.exports = function importMetaStub({ types: t }) {
  return {
    name: 'import-meta-stub',
    visitor: {
      MetaProperty(path) {
        if (path.node.meta.name === 'import' && path.node.property.name === 'meta') {
          path.replaceWith(t.objectExpression([]));
        }
      },
    },
  };
};
