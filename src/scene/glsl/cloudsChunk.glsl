vec2 cloudsUV1 = (wPos.xz * 0.003 + 31.232) + vec2(time * 0.0139 + 13.243, time * 0.02789 - 23.3) * 0.25;
    vec2 cloudsUV2 = wPos.xz * 0.003 - 65.1345 + vec2(time * -0.0123 + 113.82, time * 0.01525 - 34.234) * 0.25;
    float cloud_dither = rand(gl_FragCoord.xy) * 0.002;
    float cloudsMult1 = texture2D(tCloudsTop, cloudsUV1 + cloud_dither).r;
    float cloudsMult2 = texture2D(tCloudsTop, cloudsUV2 + cloud_dither).r;
    float cloudsMult = smoothstep(0.2, 0.9, cloudsMult1 * cloudsMult2);
