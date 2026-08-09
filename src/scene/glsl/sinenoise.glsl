#define sinlayer(frX, frY, frZ) val += sin(dot(p, vec3(frX, frY, frZ)));
float sinenoise1(vec3 p){float val=0.0;sinlayer(1.5,3.4598,1.234);sinlayer(3.12,-3.234,4.221);sinlayer(0.355,2.3,-1.375);sinlayer(-0.156,-3.34,-0.4566);sinlayer(-4.1235,-0.485,-1.45);sinlayer(2.54,-0.879,-2.123);return val/6.0;}
