import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class GenerateCertificateDto {
  @IsNotEmpty()
  @IsUUID('all', { message: 'registrationId must be a valid registration ID.' })
  registrationId: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  recipientName: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  teamName: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(300)
  achievementTitle: string;
}
