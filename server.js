#!/usr/bin/env node
'use strict'; /*jslint node:true es9:true*/
import {FastMCP} from 'fastmcp';
import {z} from 'zod';
import axios from 'axios';
import {tools as browser_tools} from './browser_tools.js';
import {createRequire} from 'node:module';

function extractTokenFromUrl(request) {
    const url = request.url || '';
    const tokenMatch = url.match(/token=([a-zA-Z0-9_-]+)/);
    return tokenMatch ? tokenMatch[1] : null;
}

function extractUrlParams(request) {
    const url = request.url || '';
    const params = {};
    
    const tokenMatch = url.match(/token=([a-zA-Z0-9_-]+)/);
    if (tokenMatch) params.token = tokenMatch[1];
    
    const unlockerMatch = url.match(/unlocker=([a-zA-Z0-9_-]+)/);
    if (unlockerMatch) params.unlocker = unlockerMatch[1];
    
    const browserMatch = url.match(/browser=([a-zA-Z0-9_-]+)/);
    if (browserMatch) params.browser = browserMatch[1];
    
    return params;
}
const require = createRequire(import.meta.url);
const package_json = require('./package.json');
const PORT = process.env.PORT || 8080;
// const api_token = process.env.API_TOKEN;
const unlocker_zone = process.env.WEB_UNLOCKER_ZONE || 'mcp_unlocker';

function parse_rate_limit(rate_limit_str) {
    if (!rate_limit_str) 
        return null;
    
    const match = rate_limit_str.match(/^(\d+)\/(\d+)([mhs])$/);
    if (!match) 
        throw new Error('Invalid RATE_LIMIT format. Use: 100/1h or 50/30m');
    
    const [, limit, time, unit] = match;
    const multiplier = unit==='h' ? 3600 : unit==='m' ? 60 : 1;
    
    return {
        limit: parseInt(limit),
        window: parseInt(time) * multiplier * 1000, 
        display: rate_limit_str
    };
}

const rate_limit_config = parse_rate_limit(process.env.RATE_LIMIT);

// if (!api_token)
//     throw new Error('Cannot run MCP server without API_TOKEN env');

const api_headers = (apiToken)=>({
    'user-agent': `${package_json.name}/${package_json.version}`,
    authorization: `Bearer ${apiToken}`,
});

function check_rate_limit(){
    if (!rate_limit_config) 
        return true;
    
    const now = Date.now();
    const window_start = now - rate_limit_config.window;
    
    debug_stats.call_timestamps = debug_stats.call_timestamps.filter(timestamp=>timestamp>window_start);
    
    if (debug_stats.call_timestamps.length>=rate_limit_config.limit)
        throw new Error(`Rate limit exceeded: ${rate_limit_config.display}`);
    
    debug_stats.call_timestamps.push(now);
    return true;
}

async function ensure_required_zones(apiToken,unlockerZone){
    try {
        console.error('Checking for required zones...');
        let response = await axios({
            url: 'https://api.brightdata.com/zone/get_active_zones',
            method: 'GET',
            headers: api_headers(apiToken),
        });
        let zones = response.data || [];
        let has_unlocker_zone = zones.some(zone=>zone.name==unlockerZone);
        if (!has_unlocker_zone)
        {
            console.error(`Required zone "${unlockerZone}" not found, `
                +`creating it...`);
            await axios({
                url: 'https://api.brightdata.com/zone',
                method: 'POST',
                headers: {
                    ...api_headers(apiToken),
                    'Content-Type': 'application/json',
                },
                data: {
                    zone: {name: unlockerZone, type: 'unblocker'},
                    plan: {type: 'unblocker'},
                },
            });
            console.error(`Zone "${unlockerZone}" created successfully`);
        }
        else
            console.error(`Required zone "${unlockerZone}" already exists`);
    } catch(e){
        console.error('Error checking/creating zones:',
            e.response?.data||e.message);
    }
}

// await ensure_required_zones();

let server = new FastMCP({
    name: 'Bright Data',
    version: package_json.version,
    roots: {
        enabled: false 
    },
    authenticate: async (request) => {
    const authHeader = request.headers['authorization'];
    let clientApiToken = null;
    const urlParams = extractUrlParams(request);
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
        clientApiToken = authHeader.substring(7);
    } else {
        clientApiToken = urlParams.token;
    }
    
    if (!clientApiToken) {
        throw new Response(null, {
            status: 401,
            statusText: 'Unauthorized - Missing API Token'
        });
    }
    
    if (!clientApiToken.match(/^[a-zA-Z0-9_-]+$/)) {
        throw new Response(null, {
            status: 401,
            statusText: 'Invalid API Token Format'
        });
    }
    
    // Check zones during authentication
    const unlockerZone = urlParams.unlocker || process.env.WEB_UNLOCKER_ZONE || 'mcp_unlocker';
    const browserZone = urlParams.browser || process.env.BROWSER_ZONE || 'mcp_browser';
    
    console.error('Authentication successful, checking zones...');
    try {
        await ensure_required_zones(clientApiToken, unlockerZone);
        console.error('Zone check completed');
    } catch(e) {
        console.error('Zone check failed:', e.message);
        // Don't fail authentication if zone check fails
    }
    
    return {
        apiToken: clientApiToken,
        unlockerZone: unlockerZone,
        browserZone: browserZone
    };
}
});

let debug_stats = {tool_calls: {}, session_calls: 0, call_timestamps: []};
server.addTool({
    name: 'search_engine',
    description: 'Scrape search results from Google, Bing or Yandex. Returns '
    +'SERP results in markdown (URL, title, description)',
    parameters: z.object({
        query: z.string(),
        engine: z.enum([
            'google',
            'bing',
            'yandex',
        ]).optional().default('google'),
        cursor: z.string().optional().describe('Pagination cursor for next page'),
    }),
    execute: tool_fn('search_engine', async({query, engine, cursor}, ctx)=>{
        let response = await axios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url: search_url(engine, query, cursor),
                zone: ctx.unlockerZone, 
                format: 'raw',
                data_format: 'markdown',
            },
            headers: api_headers(ctx.apiToken),  
            responseType: 'text',
        });
        return response.data;
    }),
});

server.addTool({
    name: 'scrape_as_markdown',
    description: 'Scrape a single webpage URL with advanced options for '
    +'content extraction and get back the results in MarkDown language. '
    +'This tool can unlock any webpage even if it uses bot detection or '
    +'CAPTCHA.',
    parameters: z.object({url: z.string().url()}),
    execute: tool_fn('scrape_as_markdown', async({url}, ctx)=>{
        let response = await axios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url,
                zone: ctx.unlockerZone,
                format: 'raw',
                data_format: 'markdown',
            },
            headers: api_headers(ctx.apiToken),
            responseType: 'text',
        });
        return response.data;
    }),
});
server.addTool({
    name: 'scrape_as_html',
    description: 'Scrape a single webpage URL with advanced options for '
    +'content extraction and get back the results in HTML. '
    +'This tool can unlock any webpage even if it uses bot detection or '
    +'CAPTCHA.',
    parameters: z.object({url: z.string().url()}),
    execute: tool_fn('scrape_as_html', async({url}, ctx)=>{
        let response = await axios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url,
                zone: ctx.unlockerZone,
                format: 'raw',
            },
            headers: api_headers(ctx.apiToken),
            responseType: 'text',
        });
        return response.data;
    }),
});
server.addTool({
    name: 'search',
    description: 'Search for relevant documents and return a list of search results for deep research',
    parameters: z.object({
        query: z.string().describe('Search query string')
    }),
    execute: tool_fn('search', async({query}, ctx) => {
        console.error(`[search] Executing search for: ${query}`);
        
        let response = await axios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url: `${search_url('google', query, 0)}&brd_json=1`,
                zone: ctx.unlockerZone,
                format: 'raw',
            },
            headers: api_headers(ctx.apiToken),
            responseType: 'text',
        });

        console.error(`[search] Raw response length: ${response.data.length}`);
        
        let searchData;
        try {
            searchData = JSON.parse(response.data);
            console.error(`[search] Parsed JSON successfully`);
        } catch (e) {
            console.error(`[search] JSON parse error: ${e.message}`);
            console.error(`[search] Raw response: ${response.data.substring(0, 500)}...`);
            throw new Error(`Failed to parse search results JSON: ${e.message}`);
        }

        const results = [];
        
        if (searchData.organic && Array.isArray(searchData.organic)) {
            console.error(`[search] Found ${searchData.organic.length} organic results`);
            
            searchData.organic.forEach((result, index) => {
                if (result.link && result.title) {
                    results.push({
                        id: result.link,
                        title: result.title || 'Untitled',
                        text: result.description || '',
                        url: result.link || ''
                    });
                }
            });
        } else {
            console.error(`[search] No organic results found or not an array`);
            console.error(`[search] searchData keys: ${Object.keys(searchData)}`);
        }

        console.error(`[search] Returning ${results.length} results`);
        
        return JSON.stringify(results);
    })
});
server.addTool({
    name: 'fetch',
    description: 'Retrieve the full content of a document by its URL for deep research',
    parameters: z.object({
        id: z.string().url().describe('URL of the document to fetch and return full content')
    }),
    execute: tool_fn('fetch', async({id}, ctx) => {
        const url = id; // id parameter is actually the URL
        
        // Scrape the full content
        let response = await axios({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            data: {
                url,
                zone: ctx.unlockerZone,
                format: 'raw',
                data_format: 'markdown',
            },
            headers: api_headers(ctx.apiToken),
            responseType: 'text',
        });

        // Extract title from markdown content
        function extractTitleFromMarkdown(content) {
            const lines = content.split('\n');
            for (let line of lines) {
                if (line.startsWith('# ')) {
                    return line.substring(2).trim();
                }
            }
            return 'Untitled Document';
        }

        return JSON.stringify({
            id: url,
            title: extractTitleFromMarkdown(response.data),
            text: response.data,
            url: url,
            metadata: {
                scraped_at: new Date().toISOString(),
                content_type: 'markdown'
            }
        });
    })
});
server.addTool({
    name: 'session_stats',
    description: 'Tell the user about the tool usage during this session',
    parameters: z.object({}),
    execute: tool_fn('session_stats', async() =>{
        let used_tools = Object.entries(debug_stats.tool_calls);
        let lines = ['Tool calls this session:'];
        for (let [name, calls] of used_tools)
            lines.push(`- ${name} tool: called ${calls} times`);
        return lines.join('\n');
    }),
});

const datasets = [{
    id: 'amazon_product',
    dataset_id: 'gd_l7q7dkf244hwjntr0',
    description: [
        'Quickly read structured amazon product data.',
        'Requires a valid product URL with /dp/ in it.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'amazon_product_reviews',
    dataset_id: 'gd_le8e811kzy4ggddlq',
    description: [
        'Quickly read structured amazon product review data.',
        'Requires a valid product URL with /dp/ in it.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'amazon_product_search',
    dataset_id: 'gd_lwdb4vjm1ehb499uxs',
    description: [
        'Quickly read structured amazon product search data.',
        'Requires a valid search keyword and amazon domain URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['keyword', 'url', 'pages_to_search'],
    defaults: {pages_to_search: '1'},
}, {
    id: 'walmart_product',
    dataset_id: 'gd_l95fol7l1ru6rlo116',
    description: [
        'Quickly read structured walmart product data.',
        'Requires a valid product URL with /ip/ in it.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'walmart_seller',
    dataset_id: 'gd_m7ke48w81ocyu4hhz0',
    description: [
        'Quickly read structured walmart seller data.',
        'Requires a valid walmart seller URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'ebay_product',
    dataset_id: 'gd_ltr9mjt81n0zzdk1fb',
    description: [
        'Quickly read structured ebay product data.',
        'Requires a valid ebay product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'homedepot_products',
    dataset_id: 'gd_lmusivh019i7g97q2n',
    description: [
        'Quickly read structured homedepot product data.',
        'Requires a valid homedepot product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'zara_products',
    dataset_id: 'gd_lct4vafw1tgx27d4o0',
    description: [
        'Quickly read structured zara product data.',
        'Requires a valid zara product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'etsy_products',
    dataset_id: 'gd_ltppk0jdv1jqz25mz',
    description: [
        'Quickly read structured etsy product data.',
        'Requires a valid etsy product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'bestbuy_products',
    dataset_id: 'gd_ltre1jqe1jfr7cccf',
    description: [
        'Quickly read structured bestbuy product data.',
        'Requires a valid bestbuy product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_person_profile',
    dataset_id: 'gd_l1viktl72bvl7bjuj0',
    description: [
        'Quickly read structured linkedin people profile data.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_company_profile',
    dataset_id: 'gd_l1vikfnt1wgvvqz95w',
    description: [
        'Quickly read structured linkedin company profile data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_job_listings',
    dataset_id: 'gd_lpfll7v5hcqtkxl6l',
    description: [
        'Quickly read structured linkedin job listings data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_posts',
    dataset_id: 'gd_lyy3tktm25m4avu764',
    description: [
        'Quickly read structured linkedin posts data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'linkedin_people_search',
    dataset_id: 'gd_m8d03he47z8nwb5xc',
    description: [
        'Quickly read structured linkedin people search data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url', 'first_name', 'last_name'],
}, {
    id: 'crunchbase_company',
    dataset_id: 'gd_l1vijqt9jfj7olije',
    description: [
        'Quickly read structured crunchbase company data',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'zoominfo_company_profile',
    dataset_id: 'gd_m0ci4a4ivx3j5l6nx',
    description: [
        'Quickly read structured ZoomInfo company profile data.',
        'Requires a valid ZoomInfo company URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'instagram_profiles',
    dataset_id: 'gd_l1vikfch901nx3by4',
    description: [
        'Quickly read structured Instagram profile data.',
        'Requires a valid Instagram URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'instagram_posts',
    dataset_id: 'gd_lk5ns7kz21pck8jpis',
    description: [
        'Quickly read structured Instagram post data.',
        'Requires a valid Instagram URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'instagram_reels',
    dataset_id: 'gd_lyclm20il4r5helnj',
    description: [
        'Quickly read structured Instagram reel data.',
        'Requires a valid Instagram URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'instagram_comments',
    dataset_id: 'gd_ltppn085pokosxh13',
    description: [
        'Quickly read structured Instagram comments data.',
        'Requires a valid Instagram URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'facebook_posts',
    dataset_id: 'gd_lyclm1571iy3mv57zw',
    description: [
        'Quickly read structured Facebook post data.',
        'Requires a valid Facebook post URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'facebook_marketplace_listings',
    dataset_id: 'gd_lvt9iwuh6fbcwmx1a',
    description: [
        'Quickly read structured Facebook marketplace listing data.',
        'Requires a valid Facebook marketplace listing URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'facebook_company_reviews',
    dataset_id: 'gd_m0dtqpiu1mbcyc2g86',
    description: [
        'Quickly read structured Facebook company reviews data.',
        'Requires a valid Facebook company URL and number of reviews.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url', 'num_of_reviews'],
}, {
    id: 'facebook_events',
    dataset_id: 'gd_m14sd0to1jz48ppm51',
    description: [
        'Quickly read structured Facebook events data.',
        'Requires a valid Facebook event URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'tiktok_profiles',
    dataset_id: 'gd_l1villgoiiidt09ci',
    description: [
        'Quickly read structured Tiktok profiles data.',
        'Requires a valid Tiktok profile URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'tiktok_posts',
    dataset_id: 'gd_lu702nij2f790tmv9h',
    description: [
        'Quickly read structured Tiktok post data.',
        'Requires a valid Tiktok post URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'tiktok_shop',
    dataset_id: 'gd_m45m1u911dsa4274pi',
    description: [
        'Quickly read structured Tiktok shop data.',
        'Requires a valid Tiktok shop product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'tiktok_comments',
    dataset_id: 'gd_lkf2st302ap89utw5k',
    description: [
        'Quickly read structured Tiktok comments data.',
        'Requires a valid Tiktok video URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'google_maps_reviews',
    dataset_id: 'gd_luzfs1dn2oa0teb81',
    description: [
        'Quickly read structured Google maps reviews data.',
        'Requires a valid Google maps URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url', 'days_limit'],
    defaults: {days_limit: '3'},
}, {
    id: 'google_shopping',
    dataset_id: 'gd_ltppk50q18kdw67omz',
    description: [
        'Quickly read structured Google shopping data.',
        'Requires a valid Google shopping product URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'google_play_store',
    dataset_id: 'gd_lsk382l8xei8vzm4u',
    description: [
        'Quickly read structured Google play store data.',
        'Requires a valid Google play store app URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'apple_app_store',
    dataset_id: 'gd_lsk9ki3u2iishmwrui',
    description: [
        'Quickly read structured apple app store data.',
        'Requires a valid apple app store app URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'reuter_news',
    dataset_id: 'gd_lyptx9h74wtlvpnfu',
    description: [
        'Quickly read structured reuter news data.',
        'Requires a valid reuter news report URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'github_repository_file',
    dataset_id: 'gd_lyrexgxc24b3d4imjt',
    description: [
        'Quickly read structured github repository data.',
        'Requires a valid github repository file URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'yahoo_finance_business',
    dataset_id: 'gd_lmrpz3vxmz972ghd7',
    description: [
        'Quickly read structured yahoo finance business data.',
        'Requires a valid yahoo finance business URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'x_posts',
    dataset_id: 'gd_lwxkxvnf1cynvib9co',
    description: [
        'Quickly read structured X post data.',
        'Requires a valid X post URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'zillow_properties_listing',
    dataset_id: 'gd_lfqkr8wm13ixtbd8f5',
    description: [
        'Quickly read structured zillow properties listing data.',
        'Requires a valid zillow properties listing URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'booking_hotel_listings',
    dataset_id: 'gd_m5mbdl081229ln6t4a',
    description: [
        'Quickly read structured booking hotel listings data.',
        'Requires a valid booking hotel listing URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'youtube_profiles',
    dataset_id: 'gd_lk538t2k2p1k3oos71',
    description: [
        'Quickly read structured youtube profiles data.',
        'Requires a valid youtube profile URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}, {
    id: 'youtube_comments',
    dataset_id: 'gd_lk9q0ew71spt1mxywf',
    description: [
        'Quickly read structured youtube comments data.',
        'Requires a valid youtube video URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url', 'num_of_comments'],
    defaults: {num_of_comments: '10'},
}, {
    id: 'reddit_posts',
    dataset_id: 'gd_lvz8ah06191smkebj4',
    description: [
        'Quickly read structured reddit posts data.',
        'Requires a valid reddit post URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
},
{
    id: 'youtube_videos',
    dataset_id: 'gd_m5mbdl081229ln6t4a',
    description: [
        'Quickly read structured YouTube videos data.',
        'Requires a valid YouTube video URL.',
        'This can be a cache lookup, so it can be more reliable than scraping',
    ].join('\n'),
    inputs: ['url'],
}];
for (let {dataset_id, id, description, inputs, defaults = {}} of datasets)
{
    let parameters = {};
    for (let input of inputs)
    {
        let param_schema = input=='url' ? z.string().url() : z.string();
        parameters[input] = defaults[input] !== undefined ?
            param_schema.default(defaults[input]) : param_schema;
    }
    server.addTool({
        name: `web_data_${id}`,
        description,
        parameters: z.object(parameters),
        execute: tool_fn(`web_data_${id}`, async(data, ctx)=>{
            let trigger_response = await axios({
                url: 'https://api.brightdata.com/datasets/v3/trigger',
                params: {dataset_id, include_errors: true},
                method: 'POST',
                data: [data],
                headers: api_headers(ctx.apiToken),
            });
            if (!trigger_response.data?.snapshot_id)
                throw new Error('No snapshot ID returned from request');
            let snapshot_id = trigger_response.data.snapshot_id;
            console.error(`[web_data_${id}] triggered collection with `
                +`snapshot ID: ${snapshot_id}`);
            let max_attempts = 600;
            let attempts = 0;
            while (attempts < max_attempts)
            {
                try {
                    if (ctx && ctx.reportProgress)
                    {
                        await ctx.reportProgress({
                            progress: attempts,
                            total: max_attempts,
                            message: `Polling for data (attempt `
                                +`${attempts + 1}/${max_attempts})`,
                        });
                    }
                    let snapshot_response = await axios({
                        url: `https://api.brightdata.com/datasets/v3`
                            +`/snapshot/${snapshot_id}`,
                        params: {format: 'json'},
                        method: 'GET',
                        headers: api_headers(ctx.apiToken),
                    });
                    if (snapshot_response.data?.status === 'running')
                    {
                        console.error(`[web_data_${id}] snapshot not ready, `
                            +`polling again (attempt `
                            +`${attempts + 1}/${max_attempts})`);
                        attempts++;
                        await new Promise(resolve=>setTimeout(resolve, 1000));
                        continue;
                    }
                    console.error(`[web_data_${id}] snapshot data received `
                        +`after ${attempts + 1} attempts`);
                    let result_data = JSON.stringify(snapshot_response.data);
                    return result_data;
                } catch(e){
                    console.error(`[web_data_${id}] polling error: `
                        +`${e.message}`);
                    attempts++;
                    await new Promise(resolve=>setTimeout(resolve, 1000));
                }
            }
            throw new Error(`Timeout after ${max_attempts} seconds waiting `
                +`for data`);
        }),
    });
}

for (let tool of browser_tools) {
    const originalExecute = tool.execute;
    server.addTool({
        ...tool,
        execute: async (params, ctx) => {
            if (!ctx.session?.browserZone) {
                throw new Error('Browser tools require a browser zone. Specify browser=ZONE_NAME in the URL.');
            }
            const extendedCtx = {
                ...ctx,
                apiToken: ctx.session.apiToken,
                browserZone: ctx.session.browserZone
            };
            return originalExecute(params, extendedCtx);
        }
    });
}

console.error('Starting server...');
server.start({
    transportType: 'httpStream',
    httpStream: {
        port: PORT,
        endpoint: '/mcp',
        corsOptions: {
            origin: '*',
            credentials: true
        }
    }
});
console.error(`Server running on http://localhost:${PORT}/mcp`);
function tool_fn(name, fn){
    return async(data, ctx)=>{
        check_rate_limit();
        debug_stats.tool_calls[name] = debug_stats.tool_calls[name]||0;
        debug_stats.tool_calls[name]++;
        debug_stats.session_calls++;
        let ts = Date.now();
        console.error(`[%s] executing %s`, name, JSON.stringify(data));
        const apiToken = ctx.session?.apiToken;
        if (!apiToken) {
            throw new Error('No API token available in session');
        }
        const extendedCtx = {
            ...ctx,
            apiToken,
            unlockerZone: ctx.session?.unlockerZone || unlocker_zone,
            browserZone: ctx.session?.browserZone || process.env.BROWSER_ZONE || 'mcp_browser'
        };
        
        try { return await fn(data, extendedCtx); }
        catch(e){
            if (e.response)
            {
                console.error(`[%s] error %s %s: %s`, name, e.response.status,
                    e.response.statusText, e.response.data);
                let message = e.response.data;
                if (message?.length)
                    throw new Error(`HTTP ${e.response.status}: ${message}`);
            }
            else
                console.error(`[%s] error %s`, name, e.stack);
            throw e;
        } finally {
            let dur = Date.now()-ts;
            console.error(`[%s] tool finished in %sms`, name, dur);
        }
    };
}

function search_url(engine, query, cursor){
    let q = encodeURIComponent(query);
    let page = cursor ? parseInt(cursor) : 0;
    let start = page * 10;
    if (engine=='yandex')
        return `https://yandex.com/search/?text=${q}&p=${page}`;
    if (engine=='bing')
        return `https://www.bing.com/search?q=${q}&first=${start + 1}`;
    return `https://www.google.com/search?q=${q}&start=${start}`;
}
