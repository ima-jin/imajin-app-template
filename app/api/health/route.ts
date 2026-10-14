import { NextResponse } from 'next/server';
import { isAppClaimed } from '@/lib/signing-identity';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'imajin-app-template',
    timestamp: new Date().toISOString(),
    // Unclaimed boot mode (#2427): false until an operator pastes a claim
    // code at /claim; later boots re-authenticate with the keystore.
    claimed: isAppClaimed(),
  });
}
