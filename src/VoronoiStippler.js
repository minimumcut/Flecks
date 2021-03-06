import { mat4 } from 'gl-matrix';


/* Credits to Matt Keeter for this approach https://www.mattkeeter.com/projects/swingline/ */

const centroidVertexShader = `#version 300 es
    in vec3 vertexPosition;
    uniform mat4 modelViewMatrix;

    void main(void) {
        gl_Position =  modelViewMatrix * vec4(vertexPosition, 1.0);
    }
`;


const centroidFragmentShader = `#version 300 es
    precision highp float;
    
    uniform sampler2D imageSampler;
    uniform sampler2D voronoiSampler;
    uniform int sampleOffset;
    uniform int supersampling;

    out vec4 sum;
      void main(void) {
        // GLES3.0 is missing layout qualifiers for rounded down fragcoord so round down manually
        vec4 screen_coords = vec4(floor(gl_FragCoord.x), floor(gl_FragCoord.y), floor(gl_FragCoord.z), floor(gl_FragCoord.w));
        
        int thisIndex = int(int(screen_coords.x) + sampleOffset);
        ivec2 texSize = textureSize(voronoiSampler, 0);
        sum = vec4(0.0, 0.0, 0.0, 0.0);
        for(int x = 0; x < texSize.x ; x++){
            ivec2 texCoord = ivec2(x, int(screen_coords.y));
            ivec2 texCoordImg = ivec2(x / supersampling, int(screen_coords.y)/ supersampling);
            vec4 voronoiTexel = texelFetch(voronoiSampler, texCoord, 0);
            int currentVoronoiIndex = int(255.0f * (voronoiTexel.x + (voronoiTexel.y * 256.0f) + (voronoiTexel.z * 65536.0f)));
            if(currentVoronoiIndex == thisIndex){
                vec4 imageTexel = texelFetch(imageSampler, texCoordImg, 0);
                float weight = 1.0 - 0.30 * imageTexel.x - 0.59 * imageTexel.y - 0.11 * imageTexel.z;
                weight = 0.01 + weight * 0.99; // give minum weight to avoid divide by zero
                //weight = 1.0; // For debugging, if we set weight to 1.0 it should spread out evenly
                sum.x += (float(x) + 0.5) * weight;
                sum.y += (screen_coords.y + 0.5) * weight;
                sum.z += weight;
                sum.w += 1.0;
            }   
        }
        sum.x /= float(texSize.x);
        sum.y /= float(texSize.y);
    }
`;

const outputVertexShader = `#version 300 es
    precision highp float;
    uniform sampler2D intermediateSampler;
    in float outputIndex;
    out vec3 centroidPos;
    void main(void) {
        ivec2 texSize = textureSize(intermediateSampler, 0);
        float weight = 0.0;
        float count = 0.0;
        /* Accumulate summing over columns */
        float ix = 0.0;
        float iy = 0.0;
        centroidPos = vec3(0.0f, 0.0f, 0.0f);
        for(int y = 0; y < texSize.y; y++){
            ivec2 texCoord = ivec2(int(outputIndex), y);
            vec4 intermediateTexel = texelFetch(intermediateSampler, texCoord, 0);
            ix += intermediateTexel.x;
            iy += intermediateTexel.y;
            weight += intermediateTexel.z; 
            count += intermediateTexel.w;
        }
        ix /= weight;
        iy /= weight;
        weight /= count;
        centroidPos = vec3(
            ix * 2.0 - 1.0,
            iy * 2.0 - 1.0,
            weight
        );
    }
`;

/* intel drivers have no default fragment shader for feedback transforms 
 * http://stackoverflow.com/questions/38712224/is-fragment-shader-necessary-in-intel-hd-graphic-card */
const blankFragmentShader = `#version 300 es
    precision highp float;
    out vec4 outputColor;

    void main(void) {
        outputColor = vec4(0.0, 0.0, 0.0, 0.0);
    }
`;

const voronoiVertexShader  = `#version 300 es
    precision highp float;
    layout (location = 0) in vec2 instancedPosition;
    layout (location = 1) in vec3 vertexPosition;

    out vec3 indexAsColor;
    uniform float aspectRatio;

    void main(void) {
        gl_Position = vec4(
            vertexPosition.x + instancedPosition.x,
            vertexPosition.y * aspectRatio + instancedPosition.y, 
            vertexPosition.z,
            1.0f
        );
        indexAsColor = vec3(
            float(gl_InstanceID % 256) / 255.0f, 
            float((gl_InstanceID / 256) % 256) /255.0f, 
            float((gl_InstanceID / 65536) % 256) /255.0f);
    }
`;

const voronoiFragmentShader = `#version 300 es
    precision highp float;
    
    in vec3 indexAsColor;
    out vec4 outputColor;

    void main(void) { 
        outputColor =  vec4(indexAsColor, 1.0);
    }
`;

const finalOutputFragmentShader = `#version 300 es
    precision highp float;
        out vec4 outputColor;

    void main(void) { 
        outputColor =  vec4(0.0, 0.0, 0.0, 1.0);
    }
`;

const finalOutputVertexShader  = `#version 300 es
    precision highp float;
    layout (location = 0) in vec3 instancedPosition;
    layout (location = 1) in vec3 vertexPosition;
   
    uniform vec2 scaleFactor;

    void main(void) {
        gl_Position = vec4(
            vertexPosition.x * instancedPosition.z * scaleFactor.x + instancedPosition.x,
            vertexPosition.y * instancedPosition.z * scaleFactor.y + instancedPosition.y, 
            vertexPosition.z ,
            1.0f
        );
    }
`;

class VoronoiStipplerWGL2{
    /**
     * Creates cone with the given number of edges parametrically.
     * @param {Number} samples the number of stipples to render with
     * @param {Number} iterations The number of iterations (move generators to centroids) to do 
     * @param {Element} inputImage A LOADED image DOM Element
     * @param {Number} scale The maximum width of a stipple
     * @param {Number} supersamplingAmount The amount of supersampling to do, must be a power of 2
     * @param {Function} onIterate A function that is called with the signature (Number) => any on each iteration.
    */
    constructor(samples, iterations, inputImage, scale, supersamplingAmount, onIterate){
        this.inputImage = inputImage;
        this.supersampling = supersamplingAmount;
        this.onIterate = onIterate;
        this.scale = scale;
        this.iterations = iterations;
        this.samples = samples;
        this._init();
    }

    _init(){
        this.coneResolution = 100;
        /* Init offscreen canvas */
        this.canvas = document.createElement("canvas"); 
        this.canvas.id = 'renderCanvas';
        this.canvas.width = 0;
        this.canvas.height = 1;

        this.gl = this.canvas.getContext('webgl2', {preserveDrawingBuffer: true, antialias: true });
        this.textures = {};
        this.buffers = {};
        this.centroid = {attributes: {}, uniforms: {}};
        this.voronoi = {attributes: {}, uniforms: {}};
        this.output = {attributes: {}, uniforms: {}};
        this.finalOutput = {attributes: {}, uniforms: {}};
        this.frameBuffers = {};
        this._enableExtensions();
        this._genInitialData();
        this._initGL();
        this.tick();
    }
    _enableExtensions(){
        const float_texture_ext = this.gl.getExtension('EXT_color_buffer_float');
        if(!float_texture_ext){
            console.error("This requires the EXT_color_buffer_float extension to operate!");
        } 
    }
    _initGL(){
        this.canvas.width = Math.max(this.inputImage.width);
        this.canvas.height = this.inputImage.height;
        this.canvas.id = "activeCanvas";

        this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);

        this._initShaders();

        /* Create Uniforms/Attributes*/
        this._getUniformLocations();
        this._getAttributeLocations();
        this._getBuffers();

        /* Bind data*/
        this._bindDataToBuffers();

        /* Setup Textures */
        this._initImageAsTexture();

        /* Setup Framebuffers*/
        this._initFrameBuffers();

        /* GL state toggles*/
        this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.depthFunc(this.gl.LEQUAL);
    }
    
    _initFrameBuffers(){
        this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 1);
        this.gl.activeTexture(this.gl.TEXTURE1);
        this.textures.voronoiTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures.voronoiTexture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.inputImage.width * this.supersampling, this.inputImage.height * this.supersampling, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
        
        this.frameBuffers.voronoi = this.gl.createFramebuffer();
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.frameBuffers.voronoi);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.textures.voronoiTexture, 0);

        /* Voronoi diagram needs a depthbuffer because of how the cone algorithm works */
        const renderbuffer = this.gl.createRenderbuffer();
        this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, renderbuffer);
        this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.DEPTH_COMPONENT32F, this.inputImage.width * this.supersampling, this.inputImage.height * this.supersampling);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.textures.voronoiTexture, 0);
        this.gl.framebufferRenderbuffer(this.gl.FRAMEBUFFER, this.gl.DEPTH_ATTACHMENT, this.gl.RENDERBUFFER, renderbuffer);

        
        this.gl.activeTexture(this.gl.TEXTURE2);
        this.textures.intermediateTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures.intermediateTexture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA32F, Math.min(this.samples, this.maxTextureSize), this.inputImage.height  * this.supersampling, 0, this.gl.RGBA, this.gl.FLOAT, null);
        this.frameBuffers.intermediate = this.gl.createFramebuffer();
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.frameBuffers.intermediate);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.textures.intermediateTexture, 0);
    }

    _initImageAsTexture(){
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.textures.imageTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures.imageTexture);
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
        this.gl.texImage2D(
            this.gl.TEXTURE_2D,
            0,
            this.gl.RGBA,
            this.gl.RGBA,
            this.gl.UNSIGNED_BYTE,
            this.inputImage,
        );
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST );
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST );
        /* npt textures */
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE );
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE );
    }

    /**
     * Binds string as a shader to the gl context.
     * @param {String} str The string to be bound as a shader.
     * @param {Number} shaderType Either gl.vertexShader or gl.fragmentShader
     * @return {WebGLShader} Newly bound shader.
    */
    _getShader(str, shaderType){
        const shader = this.gl.createShader(shaderType);
        
        this.gl.shaderSource(shader, str);
        this.gl.compileShader(shader);

        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
          console.error(this.gl.getShaderInfoLog(shader));
          return null;
        }
        return shader;
    }

    /**
     * Initializes the shader program
     */
    _initShaders(){
        this._initCentroidProgram();
        this._initVoronoiProgram();
        this._initOutputProgram();
        this._initFinalOutputProgram();
    }

    _initCentroidProgram(){
        /* Create shaders and shader program */
        const vertexShader = this._getShader(centroidVertexShader, this.gl.VERTEX_SHADER);
        const fragmentShader = this._getShader(centroidFragmentShader, this.gl.FRAGMENT_SHADER);

        this.centroid.shaderProgram = this.gl.createProgram();
        
        this.gl.attachShader(this.centroid.shaderProgram, vertexShader);
        this.gl.attachShader(this.centroid.shaderProgram, fragmentShader);
        this.gl.linkProgram(this.centroid.shaderProgram);

        if(!this.gl.getProgramParameter(this.centroid.shaderProgram, this.gl.LINK_STATUS)){
          console.error("Could not init centroid shaders.");
          return null;
        }
    }

    _initOutputProgram(){
        /* Create shaders and shader program */
        const vertexShader = this._getShader(outputVertexShader, this.gl.VERTEX_SHADER);
        const fragmentShader = this._getShader(blankFragmentShader, this.gl.FRAGMENT_SHADER);

        this.output.shaderProgram = this.gl.createProgram();

        this.gl.attachShader(this.output.shaderProgram, vertexShader);
        this.gl.attachShader(this.output.shaderProgram, fragmentShader);

        /* Capture output in feedback buffer */
        this.gl.transformFeedbackVaryings(this.output.shaderProgram, ['centroidPos'], this.gl.INTERLEAVED_ATTRIBS);

        this.gl.linkProgram(this.output.shaderProgram);

        if(!this.gl.getProgramParameter(this.output.shaderProgram, this.gl.LINK_STATUS)){
          console.error("Could not init output shaders.");
          return null;
        }
    }

    _initVoronoiProgram(){
        const vertexShader = this._getShader(voronoiVertexShader, this.gl.VERTEX_SHADER);
        const fragmentShader = this._getShader(voronoiFragmentShader, this.gl.FRAGMENT_SHADER);

        this.voronoi.shaderProgram = this.gl.createProgram();
        
        this.gl.attachShader(this.voronoi.shaderProgram, vertexShader);
        this.gl.attachShader(this.voronoi.shaderProgram, fragmentShader);
        this.gl.linkProgram(this.voronoi.shaderProgram);

        if(!this.gl.getProgramParameter(this.voronoi.shaderProgram, this.gl.LINK_STATUS)){
          console.error("Could not init voronoi shaders.");
          return null;
        }
    }

    _initFinalOutputProgram(){
        const vertexShader = this._getShader(finalOutputVertexShader, this.gl.VERTEX_SHADER);
        const fragmentShader = this._getShader(finalOutputFragmentShader, this.gl.FRAGMENT_SHADER);

        this.finalOutput.shaderProgram = this.gl.createProgram();
        
        this.gl.attachShader(this.finalOutput.shaderProgram, vertexShader);
        this.gl.attachShader(this.finalOutput.shaderProgram, fragmentShader);
        this.gl.linkProgram(this.finalOutput.shaderProgram);

        if(!this.gl.getProgramParameter(this.finalOutput.shaderProgram, this.gl.LINK_STATUS)){
          console.error("Could not init finaloutput shaders.");
          return null;
        }
    }

    /**
     * Create quad
     * @param {Number} x x-coordinate of the center on the current coordinate system
     * @param {Number} y x-coordinate of the center on the current coordinate system
     * @param {Number} edges The number of edges for the base to have (not the total)
    */
    _createQuad(x, y, edges){
        return [
            -1.0, -1.0, -1.0,
            -1.0, 1.0, -1.0,
            1.0, -1.0, -1.0,
            1.0, 1.0, -1.0,
        ];
    }

    /**
     * Creates cone with the given number of edges parametrically.
     * @param {Number} x x-coordinate of the center on the current coordinate system
     * @param {Number} y x-coordinate of the center on the current coordinate system
     * @param {Number} edges The number of edges for the base to have (not the total)
    */
    _createCone(x, y, edges){
        const pi = Math.PI;
        const vertices = new Array(edges*(3+2));
        
        /* Center of cone */
        vertices[0] = x;
        vertices[1] = y;
        vertices[2] = -1;
        
        for(let i = 1 ; i <= edges+2; i++){
            const ratio = i/edges;
            vertices[i*3] = (x + Math.sin(2 * pi * ratio));
            vertices[i*3+1] = (y + Math.cos(2 * pi * ratio));
            vertices[i*3+2] = 1;
        }
        return vertices;
    }
    /**
     * Inserts attribute locations into this.centroid.attributes
     */
    _getAttributeLocations(){
        this.voronoi.attributes.instancedPosition = this.gl.getAttribLocation(this.voronoi.shaderProgram, "instancedPosition");
        this.gl.enableVertexAttribArray(this.voronoi.attributes.instancedPosition);

        this.finalOutput.attributes.instancedPosition = this.gl.getAttribLocation(this.finalOutput.shaderProgram, "instancedPosition");
        this.gl.enableVertexAttribArray(this.finalOutput.attributes.instancedPosition);

        this.output.attributes.outputIndex = this.gl.getAttribLocation(this.output.shaderProgram, "outputIndex");
        this.gl.enableVertexAttribArray(this.output.attributes.outputIndex);

        this.voronoi.attributes.vertexPosition = this.gl.getAttribLocation(this.voronoi.shaderProgram, "vertexPosition");
        this.gl.enableVertexAttribArray(this.voronoi.attributes.vertexPosition);

        this.centroid.attributes.vertexPosition = this.gl.getAttribLocation(this.centroid.shaderProgram, "vertexPosition");
        this.gl.enableVertexAttribArray(this.centroid.attributes.vertexPosition);

        this.finalOutput.attributes.vertexPosition = this.gl.getAttribLocation(this.finalOutput.shaderProgram, "vertexPosition");
        this.gl.enableVertexAttribArray(this.finalOutput.attributes.vertexPosition);
    }

    /**
     * Inserts uniform locations into this.centroid.attributes
     */
    _getUniformLocations(){
         this.centroid.uniforms.modelViewMatrix = this.gl.getUniformLocation(this.centroid.shaderProgram, "modelViewMatrix");
         this.centroid.uniforms.imageSampler = this.gl.getUniformLocation(this.centroid.shaderProgram, "imageSampler");
         this.centroid.uniforms.voronoiSampler = this.gl.getUniformLocation(this.centroid.shaderProgram, "voronoiSampler");
         this.centroid.uniforms.sampleOffset = this.gl.getUniformLocation(this.centroid.shaderProgram, "sampleOffset");
         this.centroid.uniforms.supersampling = this.gl.getUniformLocation(this.centroid.shaderProgram, "supersampling");

         this.output.uniforms.modelViewMatrix = this.gl.getUniformLocation(this.output.shaderProgram, "modelViewMatrix");
         this.output.uniforms.intermediateSampler = this.gl.getUniformLocation(this.output.shaderProgram, "intermediateSampler");
         this.output.uniforms.windowDimensions = this.gl.getUniformLocation(this.output.shaderProgram, "windowDimensions");
         this.output.uniforms.supersampling = this.gl.getUniformLocation(this.output.shaderProgram, "supersampling");

         this.voronoi.uniforms.aspectRatio = this.gl.getUniformLocation(this.voronoi.shaderProgram, "aspectRatio");
         this.voronoi.uniforms.vertexColor = this.gl.getUniformLocation(this.voronoi.shaderProgram, "vertexColor");

         this.finalOutput.uniforms.scaleFactor = this.gl.getUniformLocation(this.finalOutput.shaderProgram, "scaleFactor");
    }

    /**
     * Gets buffers and inserts them into this.buffers
     */
    _getBuffers(){
        this.buffers.quadPositionBuffer = this.gl.createBuffer();
        this.buffers.conePositionBuffer = this.gl.createBuffer();
        this.buffers.instancedPositionBuffer = this.gl.createBuffer();
        this.buffers.outputIndiceBuffer = this.gl.createBuffer();
    }

    /**
     * Generates geometry and color data then binds it to the appropriate buffers
     */
    _bindDataToBuffers(){
        /* Bind Quad Data*/
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.quadPositionBuffer);
        const quadVertices = this._createQuad();
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(quadVertices), this.gl.STATIC_DRAW);

        /* Bind Instanced Cone Positions */
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.instancedPositionBuffer);
        const points = [];
        this.points.forEach(point => {
            points.push(point.x / this.inputImage.width * 2.0 - 1);
            points.push(1 - point.y / this.inputImage.height * 2.0);
            points.push(0.8);
        });

        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(points), this.gl.STATIC_DRAW);

        /* Bind Cone Data*/
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.conePositionBuffer);
        const coneVertices = this._createCone(0, 0, this.coneResolution);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(coneVertices), this.gl.STATIC_DRAW);

        /* Bind output indice data*/
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.outputIndiceBuffer);
        const indices = (new Array(this.samples).fill(1)).map((item, idx) => idx);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Uint32Array(indices), this.gl.STATIC_DRAW);
    }

    halt(){
        this.iterations = 0;
    }
    
    tick(){
        this.iterations--;
        if(this.iterations > 0){
            //Delay is to prevent it from freezing up system
            setTimeout(() => requestAnimationFrame(() => this.tick()),  1000);
            this.render();

            this._renderFinalOutput();
            //this._renderVoronoi(null);
        }
        else{
            this._drawPointsOntoCanvas();
        }
        this.onIterate(this.iterations);
    }

    _drawPointsOntoCanvas(){
        this._renderFinalOutput();
    }

    /* Generates intial data using rejection sampling.
     * See the Wikipedia page on intensity to see where these 
     * numbers come from. */
    _genInitialData(){
        this.points = [];
        /* Use temporary canvas to load image to get luminesence values.*/
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.inputImage.width;
        tempCanvas.height = this.inputImage.height;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(this.inputImage, 0, 0);
        const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        let i = 0;
        while(i < this.samples){
            const x = Math.random() * this.inputImage.width;
            const y = Math.random() * this.inputImage.height;
            const index = Math.floor(x) * 4 + Math.floor(y) * this.inputImage.width * 4;
            const red = imageData.data[ index ];
            const blue = imageData.data[ index + 1 ];
            const green = imageData.data[ index + 2 ];
            
            if(Math.random() * 255 > red * 0.30 + 0.59 * blue + 0.11 * green){
                this.points.push({x, y, weight: 255});
                i++;
            }
        }
    }

    /**
     * Encodes an int as a nomralized float..
     * @param {Number} i Must be a whole number
     * @return {Float32Array} A 3 dimensional array representing i
    */
    _encodeIntToRGB(i){
        const r = i % 256;
        const g = Math.floor( i / 256 ) % 256;
        const b = Math.floor( i / 65536 ) % 256;
        return new Float32Array([r / 255.0, g / 255.0 , b /255.0]);
    }

    _renderFinalOutput(){
        this.gl.viewport(0, 0, this.inputImage.width, this.inputImage.height);
        this.gl.clearColor(1.0, 1.0, 1.0, 1.0);
        this.gl.useProgram(this.finalOutput.shaderProgram);
        
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        this.gl.uniform2f(this.finalOutput.uniforms.scaleFactor, this.scale / this.inputImage.width, this.scale / this.inputImage.height);

        /* Render Voronoi to framebuffer */
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.viewport(0, 0, this.inputImage.width, this.inputImage.height);

        /* Bind instanced positions*/
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.instancedPositionBuffer);
        this.gl.vertexAttribPointer(this.finalOutput.attributes.instancedPosition, 3, this.gl.FLOAT, false, 0, 0);
        this.gl.vertexAttribDivisor(this.finalOutput.attributes.instancedPosition, 1);

        /* Bind Cone */
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.conePositionBuffer);
        this.gl.vertexAttribPointer(this.finalOutput.attributes.vertexPosition, 3, this.gl.FLOAT, false, 0, 0);
        this.gl.vertexAttribDivisor(this.finalOutput.attributes.vertexPosition, 0);

        this.gl.drawArraysInstanced(this.gl.TRIANGLE_FAN, 0, this.coneResolution+2, this.samples);
        
        /* this was originally done in webgl 1.0 which has no vaos */
        this.gl.vertexAttribDivisor(this.voronoi.attributes.instancedPosition, 0);
        this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
    }
    
    /**
     * Encodes the current points as a Voronoi diagram into the framebuffer.
    */
    _renderVoronoi(framebuffer){
        this.gl.useProgram(this.voronoi.shaderProgram);

        /* Render Voronoi to framebuffer */
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer);

        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        this.gl.viewport(0, 0, this.inputImage.width * this.supersampling, this.inputImage.height * this.supersampling);


        this.gl.uniform1f(this.voronoi.uniforms.aspectRatio, this.inputImage.width/this.inputImage.height)

        /* Bind instanced positions*/
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.instancedPositionBuffer);
        this.gl.vertexAttribPointer(this.voronoi.attributes.instancedPosition, 3, this.gl.FLOAT, false, 0, 0);
        this.gl.vertexAttribDivisor(this.voronoi.attributes.instancedPosition, 1);

        /* Bind Cone */
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.conePositionBuffer);
        this.gl.vertexAttribPointer(this.voronoi.attributes.vertexPosition, 3, this.gl.FLOAT, false, 0, 0);
        this.gl.vertexAttribDivisor(this.voronoi.attributes.vertexPosition, 0);

        this.gl.drawArraysInstanced(this.gl.TRIANGLE_FAN, 0, this.coneResolution+2, this.samples);
        
        /* this was originally done in webgl 1.0 which has no vaos */
        this.gl.vertexAttribDivisor(this.voronoi.attributes.instancedPosition, 0);
    }

    /* Renders a 1xcells textures containing the centroid of each cell of the Voronoi diagram
     * encoded in the colors of each pixel */
    _renderCentroid(start, end, framebuffer){
        this.gl.useProgram(this.centroid.shaderProgram);

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer);
        this.gl.viewport(0, 0, end - start, this.inputImage.height * this.supersampling);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.quadPositionBuffer);
        this.gl.vertexAttribPointer(this.centroid.attributes.vertexPosition, 3, this.gl.FLOAT, false, 0, 0);

        /* Setup model view matrix for next voroni point */
        const modelViewMatrix = mat4.create();
        this.gl.uniformMatrix4fv(
            this.centroid.uniforms.modelViewMatrix,
            false,
            modelViewMatrix
        );
        this.gl.uniform1i(this.centroid.uniforms.sampleOffset, start);

        /* Setup Texture Samplers */
        this.gl.uniform1i(this.centroid.uniforms.imageSampler, 0);
        this.gl.uniform1i(this.centroid.uniforms.voronoiSampler, 1);
        this.gl.uniform1i(this.centroid.uniforms.supersampling, this.supersampling)
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    }

    /* Renders the 1xsamples output of the centroids to a canvas */
    _renderOutput(start, end){
        this.gl.useProgram(this.output.shaderProgram);
        
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.viewport(0, 0, end - start, 1);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffers.outputIndiceBuffer);
        this.gl.vertexAttribPointer(this.output.attributes.outputIndex, 1, this.gl.UNSIGNED_INT, false, 0, 0);

        this.gl.uniform1i(this.output.uniforms.intermediateSampler, 2);
        this.gl.bindBufferRange(
            this.gl.TRANSFORM_FEEDBACK_BUFFER,
            0,
            this.buffers.instancedPositionBuffer,
            start * 3 * 4, 
            end * 3 * 4
        );

        this.gl.beginTransformFeedback(this.gl.POINTS);
        this.gl.drawArrays(this.gl.POINTS, 0, end - start);
        this.gl.endTransformFeedback();

        this.gl.bindBufferBase(this.gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    }
    
    render(){
        this._renderVoronoi(this.frameBuffers.voronoi); 
        for(let i = 0 ; i < Math.ceil(this.samples/this.maxTextureSize); i++){
            const start = Math.floor(i * this.maxTextureSize);
            const end = Math.min(this.samples, Math.ceil((i + 1) * this.maxTextureSize));
            this._renderCentroid(start, end, this.frameBuffers.intermediate);
            this._renderOutput(start, end);
        }
    }
    getCanvasDOMNode(){
        return this.canvas;
    }
}

export default VoronoiStipplerWGL2;