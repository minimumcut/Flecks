import VoronoiStippler from './VoronoiStippler';

const fileUploader = document.getElementById('fileUploader');
const loadForm = document.getElementById('loadForm');
const preview = document.getElementById('preview');
const submitButton = document.getElementById('submitButton');
const iterationsInput = document.getElementById('iterations');
const scaleInput = document.getElementById('scale');
const stipplesInput = document.getElementById('stipples');
const supersamplingInput = document.getElementById('supersampling');
const progressContainer = document.getElementById('progress');
const fileInput = document.getElementById('file-input');
const progressBar = document.getElementById('progressbar');
const webglapp = document.getElementById('webglapp');
const incompatibilityMessage = document.getElementById('incompatibilityMessage');


let file = null;
let fileValid = false;
let activeCanvas = null;
let lastImageDomNode = null;
let unscaledImage = null;

const getCanvasValid = () => {
    /* Test for Proper WebGL Suppport*/
    const testCanvas = document.createElement("canvas");
    const testCtx = testCanvas.getContext("webgl2");
    if(!testCtx){
        return false;
    }
    const float_texture_ext = testCtx.getExtension('EXT_color_buffer_float');
    if(!float_texture_ext){
        return false;
    }
    return true;
}

let webglenabled = getCanvasValid();
if(!webglenabled){
    webglapp.style.display = "none";
    incompatibilityMessage.style.display = "block";
}


const fileChange = () => {
    const file = fileUploader.files[0];
    const prevImage = document.getElementById("imgpreview");
    const canvas = document.getElementById("activeCanvas");

    const img = document.createElement("img");
    unscaledImage = document.createElement("img");
    unscaledImage.classList.add("obj");
    unscaledImage.file = file;
    img.classList.add("obj");
    img.file = file;
    img.id= "imgpreview";
    img.classList.add("center-block")
    
    if(prevImage){
       prevImage.replaceWith(img);
    }
    else if(canvas){
        canvas.replaceWith(img);
    }
    else{
         preview.appendChild(img);
    }
    const reader = new FileReader();
    reader.onload = (
        function(aImg){
            return function(e) {
                unscaledImage.src = e.target.result;
                aImg.src = e.target.result;
            }; 
    })(img);
    reader.readAsDataURL(file);

    fileValid = true;
    if(fileValid){
        fileInput.className = "file-input-inactive";
        activeCanvas = null;
        submitButton.disabled = false;
        fileUploader.disabled = false;
    }else{
        fileInput.className = "file-input-inactive";
        activeCanvas = null;
        submitButton.disabled = true;
        fileUploader.disabled = false;
    }
}

const handleOnIterate = (numIterations) => (iterationsLeft) => {
    if(iterationsLeft === 0){
        fileUploader.disabled = false;
        submitButton.disabled = false;
        progressContainer.style.display = 'none';
    }
    else{
        progressContainer.style.display = 'block';
        console.log(Math.ceil((numIterations-iterationsLeft)/numIterations * 100)  + '%');
        progressBar['aria-valuenow'] = Math.ceil((numIterations-iterationsLeft)/numIterations * 100);
        progressBar.style.width = Math.ceil((numIterations-iterationsLeft)/numIterations * 100 )+ '%';
    }
};

const formSubmit = (event) => {
    event.preventDefault();
    fileUploader.disabled = true;
    submitButton.disabled = true;
    
    
    /* Execute voronoi */
    const numStipples = Number(stipplesInput.value);
    const numIterations = Number(iterationsInput.value);
    const scale = Number(scaleInput.value);
    const supersamplingAmount = Number(supersamplingInput.value);
    const voroni = new VoronoiStippler(
        numStipples,
        numIterations,
        unscaledImage,
        scale,
        supersamplingAmount,
        handleOnIterate(numIterations)
    );
    const canvas = voroni.getCanvasDOMNode();
    canvas.classList.add("center-block");
    if(activeCanvas){
        activeCanvas.replaceWith(canvas);
    }
    else{
        const prevImage = document.getElementById("imgpreview");
        prevImage.replaceWith(canvas);
    }
    activeCanvas = canvas;
}

loadForm.onsubmit = formSubmit;
fileUploader.onchange = fileChange;

