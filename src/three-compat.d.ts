import type { UniformsGroup } from 'three';

declare module 'three' {
  interface ShaderMaterialParameters {
    uniformsGroups?: UniformsGroup[];
  }
}
