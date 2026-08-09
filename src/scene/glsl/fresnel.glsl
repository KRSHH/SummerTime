float fresnel(vec3 viewNormal,vec3 viewPos,float power){vec3 normal=normalize(viewNormal);vec3 dir=normalize(-viewPos);return pow(1.0-max(0.0,dot(dir,normal)),power);}
