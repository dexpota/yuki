export { CataloguePage } from './browse/CataloguePage.js';
export { ModelPage } from './detail/ModelPage.js';

export const catalogueRoutes = {
  browse: '/',
  model: '/catalogue/models/:modelId',
} as const;
