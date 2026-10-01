void instancingStage(inout ProcessedAttributes attributes) 
{
    vec3 positionMC = attributes.positionMC;
    
    mat4 instancingTransform = getInstancingTransform();
    
    attributes.positionMC = (instancingTransform * vec4(positionMC, 1.0)).xyz;

    #ifdef HAS_NORMALS
    vec3 normalMC = attributes.normalMC;
    #ifdef HAS_INSTANCE_NORMAL_TRANSFORM
    mat3 linearTransform = mat3(instancingTransform);
    mat3 normalTransform = mat3(
        cross(linearTransform[1], linearTransform[2]),
        cross(linearTransform[2], linearTransform[0]),
        cross(linearTransform[0], linearTransform[1])
    );
    float orientation = sign(dot(linearTransform[0], normalTransform[0]));
    attributes.normalMC = orientation * normalTransform * normalMC;
    #else
    attributes.normalMC = (instancingTransform * vec4(normalMC, 0.0)).xyz;
    #endif
    #endif

    #if defined(HAS_INSTANCE_NORMAL_TRANSFORM) && defined(HAS_TANGENTS)
    attributes.tangentMC = mat3(instancingTransform) * attributes.tangentMC;
    #endif

    #if defined(HAS_INSTANCE_NORMAL_TRANSFORM) && defined(HAS_BITANGENTS)
    attributes.bitangentMC = mat3(instancingTransform) * attributes.bitangentMC;
    #endif

    #ifdef USE_2D_INSTANCING
    mat4 instancingTransform2D = getInstancingTransform2D();
    attributes.position2D = (instancingTransform2D * vec4(positionMC, 1.0)).xyz;
    #endif
}
