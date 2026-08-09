//- edit

    #define PHONG

    ${globalUBO}
    ${linearstep}
    ${fit}
    ${colorutils}
    ${fogChunk}

    uniform vec3 diffuse;
    uniform vec3 emissive;
    uniform vec3 specular;
    uniform float shininess;
    uniform float opacity;

    #ifdef IS_CHARACTER
        varying float vSeed;
    #endif

    #ifdef IS_TERRAIN
        uniform sampler2D tMasks;
        uniform sampler2D tTerrNoises;
        uniform sampler2D tTerrDetails;
        uniform vec3 grassColor1;
        uniform vec3 grassColor2;
    #endif

    #if defined(USE_RAMP)
        uniform sampler2D tRamp;
        varying vec2 vColorInfo;

        float getRamp(float index) {
            const float rampStep = 1.0 / 100.0;
            return 1.0 - index * rampStep + rampStep * 0.5;
        }
    #endif

    #ifdef RECEIVE_SHADOW_CLOUDS
        uniform sampler2D tCloudsTop;
    #endif

    uniform sampler2D csmMap;
    uniform vec4 csmOptions;
    uniform vec2 csmBiases;
    uniform vec3 csmTarget;
    varying vec4 vCsmShadowCoord;
    varying vec3 wPos;

    float lineFade(vec3 p, float size, float amount) {
        float h = size * 0.5;
        return 1.0 - step(amount * 1.01, (abs(mod(p.y, size) - h) / h));
    }

    float sphereFade(vec3 p, float size, float amount) {
        float h = size * 0.5;
        return clamp(1.0 - step(amount * 1.85, length(mod(p, size) - h) / h), 0.0, 1.0);
    }

    #include <common>
    #include <packing>
    #include <uv_pars_fragment>
    #include <map_pars_fragment>
    #include <bsdfs>
    #include <lights_pars_begin>
    #include <normal_pars_fragment>
    #include <lights_phong_pars_fragment>
    #include <shadowmap_pars_fragment>

    #ifdef RANDOM_ATTRIB
        varying vec4 vRand;
    #endif

    void main() {
        #ifndef IS_CHARACTER
            float dist = length(wPos - cameraPosition);
            float showAmount = lineFade(wPos, 0.015, linearstep(1.5, 2.0, dist));
            if (showAmount < 0.001) discard;
        #endif

        vec4 diffuseColor = vec4(diffuse, opacity);

        // shadow terms filled by the CSM-tweaked lights chunk
        float _shadow0 = 1.0;
        float _csmShadow0 = 1.0;
        float _shadow1 = 1.0;
        float _csmShadow1 = 1.0;
        float _shadow2 = 1.0;
        float _csmShadow2 = 1.0;

        ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
        vec3 totalEmissiveRadiance = emissive;
        #include <specularmap_fragment>
        #include <normal_fragment_begin>

        // accumulation
        #include <lights_phong_fragment>

        // include <lights_fragment_begin>
        ${tweakedLightsFragment}

        #include <lights_fragment_end>

        vec3 diffuseSpecular = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular;

        #if NUM_DIR_LIGHTS > 0 && defined(USE_RAMP)
            DirectionalLight rampLight = directionalLights[0];
            float rampX = fit(dot(geometryNormal, rampLight.direction), -1.0, 1.0, 0.0, 1.0) * _shadow0;
            float rampStep = 1.0 / 100.0;

            #ifdef IS_TERRAIN
                // colors
                vec4 terrain = texture2D(tMasks, vUv);
                float path = smoothstep(0.35, 0.4, terrain.b);
                float road = smoothstep(0.35, 0.4, terrain.r);
                float bridge = terrain.a;

                vec3 colorGrass;
                vec3 colorPath;
                vec3 colorRoad;
                vec3 colorSand;
                vec3 colorBridge;

                // grass
                if (path < 1.0) {
                    colorGrass = mix(texture2D(tRamp, vec2(rampX, getRamp(48.0))).rgb, texture2D(tRamp, vec2(rampX, getRamp(49.0))).rgb, texture2D(tTerrNoises, wPos.xz * 0.03).r);
                    float maskGrass1 = texture2D(tTerrNoises, wPos.xz * 0.05).r;
                    float maskGrass2 = texture2D(tTerrNoises, wPos.xz * 0.1).r;
                    colorGrass = mix(colorGrass, grassColor1, texture2D(tTerrDetails, wPos.xz * 0.25).b * fit(_shadow0, 0.0, 1.0, 0.2, 1.0) * pow(maskGrass1, 2.0));
                    colorGrass = mix(colorGrass, grassColor2, texture2D(tTerrDetails, wPos.xz * 0.25).a * fit(_shadow0, 0.0, 1.0, 0.2, 1.0) * pow(maskGrass2, 2.0));
                }

                // path
                if (path > 0.0) {
                    colorPath = texture2D(tRamp, vec2(rampX, getRamp(50.0))).rgb;
                    colorPath += fit(texture2D(tTerrDetails, wPos.xz * 0.25).g, 0.0, 1.0, 0.0, 0.05) * fit(_shadow0, 0.0, 1.0, 0.3, 1.0);
                }

                diffuseSpecular = mix(colorGrass, colorPath, path);

                // road
                if (road > 0.0) {
                    colorRoad = texture2D(tRamp, vec2(rampX, getRamp(52.0))).rgb;
                    colorRoad += fit(texture2D(tTerrDetails, wPos.xz * 0.5).r, 0.0, 1.0, 0.0, 0.05) * fit(_shadow0, 0.0, 1.0, 0.3, 1.0);
                    colorRoad = mix(colorRoad, texture2D(tRamp, vec2(rampX, getRamp(63.0))).rgb, smoothstep(0.6, 0.65, texture2D(map, vUv).r));
                    diffuseSpecular = mix(diffuseSpecular, colorRoad, road);
                }

                // sand
                if (terrain.g > 0.0) {
                    colorSand = mix(texture2D(tRamp, vec2(rampX, getRamp(56.0))).rgb, texture2D(tRamp, vec2(rampX, getRamp(57.0))).rgb, texture2D(tTerrNoises, (wPos.xz + 63.6354) * 0.05).g);
                    colorSand += fit(texture2D(tTerrDetails, wPos.xz * 1.0).r, 0.0, 1.0, 0.0, 0.3) * fit(_shadow0, 0.0, 1.0, 0.3, 1.0) * texture2D(tTerrNoises, wPos.xz * 1.5).r;
                    diffuseSpecular = mix(diffuseSpecular, colorSand, terrain.g);
                }

                // bridge
                if (bridge > 0.0) {
                    colorBridge = mix(texture2D(tRamp, vec2(rampX, getRamp(54.0))).rgb, texture2D(tRamp, vec2(rampX, getRamp(55.0))).rgb, texture2D(tTerrNoises, (wPos.xz + 63.6354) * 0.03).r);
                    diffuseSpecular = mix(diffuseSpecular, colorBridge, bridge);
                }

                // sea
                float beachZone = step(50.0, wPos.x);
                if (beachZone > 0.0) {
                    float seaYLevel = -0.815 + (sin(time * 0.5 + 23.124) + sin(time * 0.15 + 3213.32)) * 0.2 + (sin(time + wPos.z) * 0.01);
                    diffuseSpecular = mix(diffuseSpecular, vec3(1.0), step(wPos.y, seaYLevel + 0.025) * beachZone);
                }

                /*
                // defined paths with small pattern details
                vec3 colorPath = texture2D(tRamp, vec2(rampX, getRamp(50.0))).rgb;
                vec3 colorRoad = texture2D(tRamp, vec2(rampX, getRamp(52.0))).rgb;
                colorRoad += fit(texture2D(tTerrDetails, wPos.xz * 0.5).r, 0.0, 1.0, 0.0, 0.05) * fit(_shadow0, 0.0, 1.0, 0.3, 1.0);

                // road details
                colorRoad = mix(colorRoad, texture2D(tRamp, vec2(rampX, getRamp(63.0))).rgb, smoothstep(0.6, 0.65, texture2D(map, vUv).r));

                colorPath += fit(texture2D(tTerrDetails, wPos.xz * 0.25).g, 0.0, 1.0, 0.0, 0.05) * fit(_shadow0, 0.0, 1.0, 0.3, 1.0);

                // special cases with more variation or custom colors
                vec3 colorGrass = mix(texture2D(tRamp, vec2(rampX, getRamp(48.0))).rgb, texture2D(tRamp, vec2(rampX, getRamp(49.0))).rgb, texture2D(tTerrNoises, wPos.xz * 0.03).r);
                vec3 colorSand = mix(texture2D(tRamp, vec2(rampX, getRamp(56.0))).rgb, texture2D(tRamp, vec2(rampX, getRamp(57.0))).rgb, texture2D(tTerrNoises, (wPos.xz + 63.6354) * 0.05).g);
                vec3 colorBridge = mix(texture2D(tRamp, vec2(rampX, getRamp(54.0))).rgb, texture2D(tRamp, vec2(rampX, getRamp(55.0))).rgb, texture2D(tTerrNoises, (wPos.xz + 63.6354) * 0.03).r);

                float maskGrass1 = texture2D(tTerrNoises, wPos.xz * 0.05).r;
                float maskGrass2 = texture2D(tTerrNoises, wPos.xz * 0.1).r;
                colorGrass = mix(colorGrass, grassColor1, texture2D(tTerrDetails, wPos.xz * 0.25).b * fit(_shadow0, 0.0, 1.0, 0.2, 1.0) * pow(maskGrass1, 2.0));
                colorGrass = mix(colorGrass, grassColor2, texture2D(tTerrDetails, wPos.xz * 0.25).a * fit(_shadow0, 0.0, 1.0, 0.2, 1.0) * pow(maskGrass2, 2.0));
                colorSand += fit(texture2D(tTerrDetails, wPos.xz * 1.0).r, 0.0, 1.0, 0.0, 0.3) * fit(_shadow0, 0.0, 1.0, 0.3, 1.0) * texture2D(tTerrNoises, wPos.xz * 1.5).r;

                // final layering of colors
                diffuseSpecular = mix(colorGrass, colorPath, path);
                diffuseSpecular = mix(diffuseSpecular, colorRoad, road);
                diffuseSpecular = mix(diffuseSpecular, colorSand, terrain.g);
                diffuseSpecular = mix(diffuseSpecular, colorBridge, bridge);

                // foam
                float beachZone = step(50.0, wPos.x);
                float seaYLevel = -0.815 + (sin(time * 0.5 + 23.124) + sin(time * 0.15 + 3213.32)) * 0.2 + (sin(time + wPos.z) * 0.01);
                diffuseSpecular = mix(diffuseSpecular, vec3(1.0), step(wPos.y, seaYLevel + 0.025) * beachZone);
                */

            #else
                #ifdef GRASS
                    // patches / opacity
                    const float grassPatches = 8.0;
                    const float grassPatchStep = 1.0 / grassPatches;
                    float grassID = floor(vRand.w * grassPatches);
                    vec2 uvgrass = vec2(grassID * grassPatchStep + vUv.x * grassPatchStep, vUv.y + 0.015);
                    vec4 grassPatch = texture2D(map, uvgrass);

                    diffuseColor.a = pow(grassPatch.a, 5.0);

                    // alpha
                    if (diffuseColor.a < 0.01) discard;

                    // save shadow contribution
                    float shadowMult = _shadow0;

                    // select ramp: 58 - 59 and get color
                    float rampID = 58.0 + step(0.8, fract(vRand.x + vRand.y));
                    diffuseSpecular = texture2D(tRamp, vec2(_shadow0, getRamp(rampID))).rgb;
                    diffuseSpecular *= fit(vUv.y, 0.0, 0.75, 1.0, 1.25);
                #elif defined(IS_CHARACTER)
                    if (vColorInfo.y < 0.01) { // not changing parts
                        float rampY = getRamp(vColorInfo.r);
                        diffuseSpecular = texture2D(tRamp, vec2(rampX, rampY)).rgb;
                    } else if (vColorInfo.y < 1.01) {
                        // skin
                        float rampY = getRamp(79.0 + clamp(floor(vSeed), 0.0, 3.0));
                        diffuseSpecular = texture2D(tRamp, vec2(rampX, rampY)).rgb;
                    } else {
                        // player color
                        vec3 cc_color = vec3(0.0);
                        cc_color.x = fract(vSeed);
                        cc_color.y = 0.4;

                        const float ss_step = 0.3;
                        cc_color.z = 0.2 + floor(rampX * 2.99) * ss_step;
                        diffuseSpecular = hsv2rgb(cc_color);
                    }
                #elif defined(GOSSIP)
                    float rampY = getRamp(vColorInfo.r);
                    vec3 col = texture2D(tRamp, vec2(rampX, rampY)).rgb;

                    if (vColorInfo.y < 0.01) {
                        float mask = texture2D(map, vUv).r;
                        diffuseSpecular = mix(texture2D(tRamp, vec2(mask, getRamp(89.0))).rgb, col, fit(mask, 0.7, 0.68, 1.0, 0.0));
                    } else {
                        diffuseSpecular = col;
                    }
                #else
                    float rampY = getRamp(vColorInfo.r);
                    diffuseSpecular = texture2D(tRamp, vec2(rampX, rampY)).rgb;
                #endif
            #endif
        #endif

        // add clouds
        #ifdef RECEIVE_SHADOW_CLOUDS
            ${cloudsChunk}
            diffuseSpecular *= fit(cloudsMult, 0.0, 1.0, 0.7, 1.0);
        #endif

        vec3 outgoingLight = diffuseSpecular + totalEmissiveRadiance;
        float lenCam = length(-vViewPosition);

        addFog(outgoingLight, lenCam);

        gl_FragColor = vec4(outgoingLight, diffuseColor.a);

        #ifdef FADE_AWAY
            gl_FragColor.a *= smoothstep(FADE_AWAY, FADE_AWAY - 5.0, length(lenCam));
        #endif

        #include <encodings_fragment>
    }
