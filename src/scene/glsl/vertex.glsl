//- edit

    #define PHONG

    ${globalUBO}
    ${sinenoise}
    ${fit}

    varying vec3 vViewPosition;

    uniform mat4 csmMatrix;
    uniform vec2 csmBiases;
    varying vec4 vCsmShadowCoord;
    varying vec3 wPos;

    #include <common>
    #include <uv_pars_vertex>
    #include <color_pars_vertex>
    #include <normal_pars_vertex>

    #ifdef USE_SKINNING
            uniform mat4 bindMatrix;
            uniform mat4 bindMatrixInverse;
            uniform sampler2D boneTexture;
            uniform int boneTextureSize;

        #ifdef IS_CHARACTER
            attribute int instanceID;
            mat4 getBoneMatrix(const in float i) {
                int x = int(i) * 4;
                vec4 v1 = texelFetch(boneTexture, ivec2(x, instanceID), 0);
                vec4 v2 = texelFetch(boneTexture, ivec2(x + 1, instanceID), 0);
                vec4 v3 = texelFetch(boneTexture, ivec2(x + 2, instanceID), 0);
                vec4 v4 = texelFetch(boneTexture, ivec2(x + 3, instanceID), 0);
                mat4 bone = mat4(v1, v2, v3, v4);
                return bone;
            }
        #else
            mat4 getBoneMatrix( const in float i ) {
                float j = i * 4.0;
                float x = mod( j, float( boneTextureSize ) );
                float y = floor( j / float( boneTextureSize ) );
                float dx = 1.0 / float( boneTextureSize );
                float dy = 1.0 / float( boneTextureSize );
                y = dy * ( y + 0.5 );
                vec4 v1 = texture2D( boneTexture, vec2( dx * ( x + 0.5 ), y ) );
                vec4 v2 = texture2D( boneTexture, vec2( dx * ( x + 1.5 ), y ) );
                vec4 v3 = texture2D( boneTexture, vec2( dx * ( x + 2.5 ), y ) );
                vec4 v4 = texture2D( boneTexture, vec2( dx * ( x + 3.5 ), y ) );
                mat4 bone = mat4( v1, v2, v3, v4 );
                return bone;
            }
        #endif
    #endif

    #if defined(MULTICOLOR) || defined(USE_RAMP)
        attribute vec2 colorInfo;
        varying vec2 vColorInfo;
    #endif

    #if defined(SHAKE) || defined(GRASS)
        float hash13(vec3 p3) {
            p3  = fract(p3 * .1031);
            p3 += dot(p3, p3.zyx + 31.32);
            return fract((p3.x + p3.y) * p3.z);
        }
    #endif

    #ifdef REACT_CHARACTER
        uniform vec3 charPos;
        uniform float charSpeed;
    #endif

    #ifdef RANDOM_ATTRIB
        attribute vec4 random;
        varying vec4 vRand;
    #endif

    #ifdef IS_CHARACTER
        attribute float instanceSeed;
        varying float vSeed;
    #endif

    #include <shadowmap_pars_vertex>

    void main() {
        #include <uv_vertex>
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <normal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>

        #ifdef IS_CHARACTER
            vSeed = instanceSeed;
        #endif

        #ifdef RANDOM_ATTRIB
            vRand = random;
        #endif

        vec4 mvPosition = vec4(transformed, 1.0);

        #ifdef PLANE_FACE_CHARACTER
            mvPosition.xz = vec2(viewMatrix[0][0], viewMatrix[2][0]) * mvPosition.x;
        #endif

        #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
        #endif

        vec4 worldPosition = modelMatrix * mvPosition;

        wPos = worldPosition.xyz;
        vec4 _wPos = worldPosition;

        #if defined(USE_RAMP)
            vColorInfo = colorInfo;
        #endif

        #ifdef SHAKE
            float mult = 1.0;
            #if defined(USE_RAMP)
                mult = colorInfo.y; // tree moving
            #endif

            #ifdef USE_INSTANCING
                float seed = hash13(instanceMatrix[3].xyz); // take tree/bush position
            #else
                float seed = hash13(_wPos.xyz); // use vertex position
            #endif

            #ifdef LIGHTWIRES
                float peri = _wPos.z * 0.05; // waviness
                float ttotal = (sin(time * 0.2 + peri) + 1.0) * 0.5;
                float amp = mult * ttotal * 0.75;
                _wPos.x += sin(time * 0.5 + peri) * amp;
            #else
                float disp = smoothstep(0.0, 2.0, mvPosition.y); //  bottom parts won't move as much
                float peri = _wPos.y * 0.3; // waviness
                float ttotal = (sin(time * (0.4 + 0.2 * seed) + seed * 120.2) + 1.0) * 0.5; // make them move only sometimes
                float amp = seed * disp * mult * ttotal * 0.2; // random multiplier from seed + limiters + max shake
                _wPos.x += sin(seed * 21.23 + time * 1.0 + peri) * amp;
                _wPos.z += sin(seed * 3.23 + time * 1.5 + peri) * amp;
            #endif
        #endif

        #ifdef GRASS
            float mult = step(0.1, position.y);
            vec3 grassPos = instanceMatrix[3].xyz;
            float grassdisp = 0.1 + 0.2 * random.x;
            float grassspeed = 0.25 + 0.3 * random.y;
            _wPos.x += sinenoise1(vec3(grassPos.x, 0.0, grassPos.z) * vec3(0.05) + time * grassspeed) * grassdisp * mult;
            _wPos.z += sinenoise1(vec3(grassPos.x, 0.0, grassPos.z) * vec3(0.1) + vec3(313.123) + time * grassspeed) * grassdisp * mult;

            vec3 grassCharDir = _wPos.xyz - charPos;
            float dist = length(grassCharDir);
            vec3 disp = normalize(grassCharDir) * fit(dist, 0.0, fit(charSpeed, 0.0, 0.01, 0.0, 1.25), 1.0, 0.0) * mult * 15.0 * charSpeed;
            _wPos.xz += disp.xz;
        #endif

        vec4 vPos = viewMatrix * _wPos;
        vViewPosition = -vPos.xyz;
        gl_Position = projectionMatrix * vPos;

        #include <shadowmap_vertex>

        vec3 csmWorldNormal = inverseTransformDirection(transformedNormal, viewMatrix);
        vec4 cmsWorldPosition = worldPosition + vec4(csmWorldNormal * csmBiases.x, 0); // shadow normal bias
        vCsmShadowCoord = csmMatrix * cmsWorldPosition;
    }
