void addFog(inout vec3 outcolor, float lenCam) {
        vec3 finalColor = rgb2hsv(outcolor);
        float fogDist = fit(lenCam, 40.0, 300.0, 0.0, 1.0);
        finalColor.b = mix(finalColor.b, 0.6, fogDist);
        finalColor.g = mix(finalColor.g, 0.3, fogDist);
        outcolor = hsv2rgb(finalColor);
    }
