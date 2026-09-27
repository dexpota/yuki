export { CataloguePage } from './browse/CataloguePage.js';
export { ModelPage } from './detail/ModelPage.js';
export { listCollections, listTags } from './api.js';

export const catalogueRoutes = {
  browse: '/',
  model: '/catalogue/models/:modelId',
} as const;
