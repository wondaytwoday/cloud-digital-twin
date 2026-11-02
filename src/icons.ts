const files=import.meta.glob('./assets/csp-icons/*/*.svg',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
export const iconUrl=(key:string|undefined)=>key?files[`./assets/csp-icons/${key}.svg`]:undefined;
