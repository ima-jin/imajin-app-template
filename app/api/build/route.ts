import { NextResponse } from 'next/server';
import { getBuildInfo } from '@/lib/build-info';

export function GET() {
  return NextResponse.json(getBuildInfo(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
