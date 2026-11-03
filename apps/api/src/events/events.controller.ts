import { Controller, MessageEvent, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { interval, map, merge, Observable } from 'rxjs';
import { AuthUser, CurrentUser } from '../auth/auth.guard';
import { EventsService } from './events.service';

@ApiTags('events')
@SkipThrottle()
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** Server-Sent Events con el progreso real de los trabajos del usuario. */
  @Sse()
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    const heartbeat = interval(25_000).pipe(map(() => ({ type: 'ping', data: { t: Date.now() } }) as MessageEvent));
    return merge(this.events.forUser(user.id) as Observable<MessageEvent>, heartbeat);
  }
}
