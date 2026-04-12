/**
 * OpenAPI Parser Service
 * Calls the public Moibe OpenAPI Parser API to extract endpoint information
 */

const PARSER_API = 'https://moibe-openapi-parser.hf.space';

export interface OpenAPIParameter {
	name: string;
	location: string;
	type: string;
	required: boolean;
	description?: string;
}

export interface OpenAPIRequestBody {
	content_type: string;
	fields: Record<string, string>;
}

export interface OpenAPIEndpoint {
	path: string;
	method: string;
	summary?: string;
	description?: string;
	operation_id?: string;
	parameters: OpenAPIParameter[];
	request_body: OpenAPIRequestBody | null;
	responses: Array<{
		status_code: string;
		description?: string;
		content_type?: string;
		fields: Record<string, string>;
	}>;
}

export interface OpenAPIResponse {
	endpoints: OpenAPIEndpoint[];
}

/**
 * Parse an OpenAPI specification from a URL
 */
export async function parseOpenAPI(openApiUrl: string, path?: string, method?: string): Promise<OpenAPIResponse> {
	try {
		// spec_url must NOT be URL-encoded — the FastAPI server expects it raw
		let url = `${PARSER_API}/parse?spec_url=${openApiUrl}`;
		if (path) url += `&path=${encodeURIComponent(path)}`;
		if (method) url += `&method=${encodeURIComponent(method)}`;
		console.log('[OpenAPI] Request:', { url });

		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(`API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as OpenAPIResponse;
		console.log('[OpenAPI] Success:', data);
		return data;
	} catch (error) {
		console.error('[OpenAPI] Error:', error);
		throw error;
	}
}
